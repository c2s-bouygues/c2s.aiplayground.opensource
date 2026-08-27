/**
 * PDF splitting for batched OCR.
 *
 * The Azure Mistral OCR deployment rejects any document over its page limit
 * (error `document_parser_too_many_pages`) even when the request narrows the
 * work with the `pages` parameter — the parser counts the WHOLE document
 * first. Batched OCR therefore needs real sub-documents.
 *
 * The host doesn't ship a PDF page-assembly library, but it does ship the
 * rasterization pair used by its own pdf-processor: `@hyzyla/pdfium` (WASM)
 * to render pages and `sharp` to encode them. Each page is rendered to a
 * baseline JPEG and the batches are reassembled into minimal image-only PDFs
 * (one full-page `/DCTDecode` XObject per page — the img2pdf construction),
 * which the OCR service parses like any scanned document.
 *
 * Both modules are loaded through a runtime `import()` kept opaque to the
 * bundler and to TypeScript (they only exist in the HOST's node_modules; the
 * plugin repo's playground fails gracefully with a clear error).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Runtime import the bundler and tsc cannot see (host-only modules). */
const loadModule = new Function('m', 'return import(m)') as (m: string) => Promise<any>;

const RENDER_SCALE = 2.0; // ≈144 dpi — same default as the host's pdf-processor
const JPEG_QUALITY = 80;

let pdfiumLibrary: any = null;

async function getPdfium(): Promise<any> {
	if (!pdfiumLibrary) {
		const mod = await loadModule('@hyzyla/pdfium');
		pdfiumLibrary = await mod.PDFiumLibrary.init();
	}
	return pdfiumLibrary;
}

interface RenderedPage {
	jpeg: Buffer;
	width: number;
	height: number;
}

export interface PdfSplitResult {
	/** One image-only PDF per batch, in document order. */
	batches: Buffer[];
	totalPages: number;
	/** true when the document exceeded maxTotalPages and was truncated. */
	capped: boolean;
}

/**
 * Render the first min(totalPages, maxTotalPages) pages and reassemble them
 * into image-only PDFs of at most `batchSize` pages each.
 * Throws with a clear message when the host modules are unavailable.
 */
export async function splitPdfIntoImageBatches(
	pdfBuffer: Buffer,
	batchSize: number,
	maxTotalPages: number
): Promise<PdfSplitResult> {
	let sharp: any;
	let pdfium: any;
	try {
		const sharpMod = await loadModule('sharp');
		sharp = sharpMod.default ?? sharpMod;
		pdfium = await getPdfium();
	} catch (error) {
		throw new Error(
			`découpage PDF indisponible sur cet hôte (@hyzyla/pdfium / sharp introuvables): ${
				error instanceof Error ? error.message : String(error)
			}`
		);
	}

	const doc = await pdfium.loadDocument(new Uint8Array(pdfBuffer));
	try {
		const totalPages: number =
			typeof doc.getPageCount === 'function' ? doc.getPageCount() : doc.pageCount;
		const capped = totalPages > maxTotalPages;
		const limit = Math.min(totalPages, maxTotalPages);

		const batches: Buffer[] = [];
		let current: RenderedPage[] = [];
		for (let i = 0; i < limit; i++) {
			const page = doc.getPage(i);
			let width = 0;
			let height = 0;
			// PDFium renders RGBA (REVERSE_BYTE_ORDER) — encode straight to JPEG
			// (alpha flattened onto white: JPEG has no alpha channel).
			const { data } = await page.render({
				scale: RENDER_SCALE,
				render: (opts: { data: Buffer; width: number; height: number }) => {
					width = opts.width;
					height = opts.height;
					return sharp(opts.data, {
						raw: { width: opts.width, height: opts.height, channels: 4 }
					})
						.flatten({ background: '#ffffff' })
						.jpeg({ quality: JPEG_QUALITY })
						.toBuffer();
				}
			});
			current.push({ jpeg: Buffer.isBuffer(data) ? data : Buffer.from(data), width, height });
			if (current.length === batchSize) {
				batches.push(buildPdfFromJpegs(current));
				current = [];
			}
		}
		if (current.length > 0) batches.push(buildPdfFromJpegs(current));

		return { batches, totalPages, capped };
	} finally {
		doc.destroy();
	}
}

/**
 * Minimal image-only PDF writer (img2pdf construction): one page per JPEG,
 * embedded as a full-page /DCTDecode XObject. MediaBox uses pixel dimensions
 * as points — proportions are exact, which is all the OCR parser needs.
 * Objects: 1 = Catalog, 2 = Pages, then (page, contents, image) per page.
 */
export function buildPdfFromJpegs(images: RenderedPage[]): Buffer {
	const chunks: Buffer[] = [];
	const offsets: number[] = [];
	let position = 0;

	const push = (part: Buffer | string) => {
		const buf = typeof part === 'string' ? Buffer.from(part, 'latin1') : part;
		chunks.push(buf);
		position += buf.length;
	};
	const beginObj = (id: number) => {
		offsets[id] = position;
		push(`${id} 0 obj\n`);
	};

	push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

	const kids = images.map((_, k) => `${3 + 3 * k} 0 R`).join(' ');
	beginObj(1);
	push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
	beginObj(2);
	push(`<< /Type /Pages /Kids [${kids}] /Count ${images.length} >>\nendobj\n`);

	for (const [k, image] of images.entries()) {
		const pageId = 3 + 3 * k;
		const contentsId = pageId + 1;
		const imageId = pageId + 2;
		const { width, height } = image;

		beginObj(pageId);
		push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
				`/Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentsId} 0 R >>\nendobj\n`
		);

		const content = `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`;
		beginObj(contentsId);
		push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);

		beginObj(imageId);
		push(
			`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} ` +
				`/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.jpeg.length} >>\nstream\n`
		);
		push(image.jpeg);
		push('\nendstream\nendobj\n');
	}

	const objectCount = 2 + 3 * images.length;
	const xrefOffset = position;
	push(`xref\n0 ${objectCount + 1}\n`);
	push('0000000000 65535 f \n');
	for (let id = 1; id <= objectCount; id++) {
		push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
	}
	push(
		`trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
	);

	return Buffer.concat(chunks);
}
