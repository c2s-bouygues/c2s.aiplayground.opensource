import { tool, jsonSchema } from 'ai';
import type { PluginContext, AnyTool } from '../../../src/types';

const PIXABAY_API_URL = 'https://pixabay.com/api/';

interface PixabayImage {
	id: number;
	pageURL: string;
	type: string;
	tags: string;
	previewURL: string;
	previewWidth: number;
	previewHeight: number;
	webformatURL: string;
	webformatWidth: number;
	webformatHeight: number;
	largeImageURL: string;
	fullHDURL?: string;
	imageURL?: string;
	imageWidth: number;
	imageHeight: number;
	imageSize: number;
	views: number;
	downloads: number;
	likes: number;
	comments: number;
	user_id: number;
	user: string;
	userImageURL: string;
}

interface PixabayResponse {
	total: number;
	totalHits: number;
	hits: PixabayImage[];
}

interface StoredImage extends PixabayImage {
	storedPreviewURL: string;
	storedWebformatURL: string;
}

interface SearchPixabayParams {
	q: string;
	lang?:
		| 'cs'
		| 'da'
		| 'de'
		| 'en'
		| 'es'
		| 'fr'
		| 'id'
		| 'it'
		| 'hu'
		| 'nl'
		| 'no'
		| 'pl'
		| 'pt'
		| 'ro'
		| 'sk'
		| 'fi'
		| 'sv'
		| 'tr'
		| 'vi'
		| 'th'
		| 'bg'
		| 'ru'
		| 'el'
		| 'ja'
		| 'ko'
		| 'zh';
	image_type?: 'all' | 'photo' | 'illustration' | 'vector';
	orientation?: 'all' | 'horizontal' | 'vertical';
	category?:
		| 'backgrounds'
		| 'fashion'
		| 'nature'
		| 'science'
		| 'education'
		| 'feelings'
		| 'health'
		| 'people'
		| 'religion'
		| 'places'
		| 'animals'
		| 'industry'
		| 'computer'
		| 'food'
		| 'sports'
		| 'transportation'
		| 'travel'
		| 'buildings'
		| 'business'
		| 'music';
	min_width?: number;
	min_height?: number;
	colors?:
		| 'grayscale'
		| 'transparent'
		| 'red'
		| 'orange'
		| 'yellow'
		| 'green'
		| 'turquoise'
		| 'blue'
		| 'lilac'
		| 'pink'
		| 'white'
		| 'gray'
		| 'black'
		| 'brown';
	editors_choice?: boolean;
	safesearch?: boolean;
	order?: 'popular' | 'latest';
	page?: number;
	per_page?: number;
}

interface MediaAttachment {
	type: 'image' | 'audio' | 'video';
	url: string;
	downloadUrl?: string;
	alt?: string;
	mimeType?: string;
}

interface SearchPixabayResult {
	message: string;
	media?: MediaAttachment[];
}

const MESSAGES = {
	fr: {
		noImagesFound: 'Aucune image trouvee pour cette recherche.',
		imagesFound: (count: number, total: string) =>
			`${count} image(s) trouvee(s) sur ${total} resultats au total.`,
		errorApiSearch: (api: string, status: number | string, statusText: string) =>
			`Erreur lors de la recherche ${api}: ${status} - ${statusText}`,
		errorNotConfigured: "L'API Pixabay n'est pas configuree (PIXABAY_API_KEY manquant).",
		errorImageSearch: (error: string) => `Erreur lors de la recherche d'images: ${error}`
	},
	en: {
		noImagesFound: 'No images found for this search.',
		imagesFound: (count: number, total: string) =>
			`${count} image(s) found out of ${total} total results.`,
		errorApiSearch: (api: string, status: number | string, statusText: string) =>
			`Error searching ${api}: ${status} - ${statusText}`,
		errorNotConfigured: 'Pixabay API is not configured (missing PIXABAY_API_KEY).',
		errorImageSearch: (error: string) => `Error searching images: ${error}`
	}
};

function getMessages(locale?: string) {
	return locale === 'en' ? MESSAGES.en : MESSAGES.fr;
}

function getExtension(url: string): string {
	const match = url.match(/\.([a-zA-Z]+)(?:\?|$)/);
	return match ? match[1] : 'jpg';
}

async function storeImageInMinio(
	image: PixabayImage,
	storage: PluginContext['storage'],
	logger: PluginContext['logger']
): Promise<StoredImage> {
	const folderPrefix = `${image.id}`;

	const [storedPreviewURL, storedWebformatURL] = await Promise.all([
		(async () => {
			const response = await fetch(image.previewURL);
			if (!response.ok) throw new Error(`Failed to fetch preview: ${response.status}`);
			const buffer = Buffer.from(await response.arrayBuffer());
			const ext = getExtension(image.previewURL);
			const filePath = `${folderPrefix}/preview.${ext}`;
			return await storage.uploadFile(filePath, buffer, `image/${ext === 'jpg' ? 'jpeg' : ext}`);
		})(),
		(async () => {
			const response = await fetch(image.webformatURL);
			if (!response.ok) throw new Error(`Failed to fetch webformat: ${response.status}`);
			const buffer = Buffer.from(await response.arrayBuffer());
			const ext = getExtension(image.webformatURL);
			const filePath = `${folderPrefix}/webformat.${ext}`;
			return await storage.uploadFile(filePath, buffer, `image/${ext === 'jpg' ? 'jpeg' : ext}`);
		})()
	]);

	logger.info('Image stored in MinIO', { imageId: image.id, storedPreviewURL, storedWebformatURL });

	return {
		...image,
		storedPreviewURL,
		storedWebformatURL
	};
}

function formatImageResults(
	response: PixabayResponse,
	storedImages: StoredImage[],
	locale?: string
): SearchPixabayResult {
	const msg = getMessages(locale);

	if (response.hits.length === 0) {
		return {
			message: msg.noImagesFound
		};
	}

	const media: MediaAttachment[] = storedImages.map((image) => ({
		type: 'image' as const,
		url: image.storedWebformatURL,
		downloadUrl: image.storedWebformatURL,
		alt: image.tags.split(',').slice(0, 3).join(', '),
		mimeType: `image/${getExtension(image.webformatURL) === 'jpg' ? 'jpeg' : getExtension(image.webformatURL)}`
	}));

	return {
		message: msg.imagesFound(response.hits.length, response.total.toLocaleString(locale || 'fr')),
		media
	};
}

/**
 * Creates the search_images tool for searching royalty-free images on Pixabay
 */
export function createSearchPixabayTool(context: PluginContext): AnyTool {
	const defaultLanguage = (context.pluginConfig.defaultLanguage as string) || 'en';
	const safeSearch = context.pluginConfig.safeSearch !== false;
	const defaultPerPage = (context.pluginConfig.defaultPerPage as number) || 6;
	const locale = context.locale;

	return tool({
		description: `Recherche des images libres de droits sur Pixabay. Retourne une liste d'images correspondant aux criteres de recherche avec URLs, metadonnees et statistiques. Utilise cet outil pour aider les utilisateurs a trouver des images pour leurs projets, presentations ou designs.`,
		inputSchema: jsonSchema<SearchPixabayParams>({
			type: 'object',
			properties: {
				q: {
					type: 'string',
					description:
						'Terme de recherche (max 100 caracteres). Sois precis pour de meilleurs resultats. En anglais de preference.'
				},
				lang: {
					type: 'string',
					enum: [
						'cs',
						'da',
						'de',
						'en',
						'es',
						'fr',
						'id',
						'it',
						'hu',
						'nl',
						'no',
						'pl',
						'pt',
						'ro',
						'sk',
						'fi',
						'sv',
						'tr',
						'vi',
						'th',
						'bg',
						'ru',
						'el',
						'ja',
						'ko',
						'zh'
					],
					description: `Code langue pour la recherche. Par defaut: ${defaultLanguage}`
				},
				image_type: {
					type: 'string',
					enum: ['all', 'photo', 'illustration', 'vector'],
					description: "Filtrer par type d'image. Par defaut: all"
				},
				orientation: {
					type: 'string',
					enum: ['all', 'horizontal', 'vertical'],
					description: 'Filtrer par orientation. Par defaut: all'
				},
				category: {
					type: 'string',
					enum: [
						'backgrounds',
						'fashion',
						'nature',
						'science',
						'education',
						'feelings',
						'health',
						'people',
						'religion',
						'places',
						'animals',
						'industry',
						'computer',
						'food',
						'sports',
						'transportation',
						'travel',
						'buildings',
						'business',
						'music'
					],
					description: 'Filtrer par categorie'
				},
				min_width: {
					type: 'number',
					description: 'Largeur minimum en pixels'
				},
				min_height: {
					type: 'number',
					description: 'Hauteur minimum en pixels'
				},
				colors: {
					type: 'string',
					enum: [
						'grayscale',
						'transparent',
						'red',
						'orange',
						'yellow',
						'green',
						'turquoise',
						'blue',
						'lilac',
						'pink',
						'white',
						'gray',
						'black',
						'brown'
					],
					description: 'Filtrer par couleur dominante'
				},
				editors_choice: {
					type: 'boolean',
					description: "Selectionner uniquement les images 'Choix de l'editeur'. Par defaut: false"
				},
				safesearch: {
					type: 'boolean',
					description: `Filtrer le contenu adulte. Par defaut: ${safeSearch}`
				},
				order: {
					type: 'string',
					enum: ['popular', 'latest'],
					description: 'Ordre de tri des resultats. Par defaut: popular'
				},
				page: {
					type: 'number',
					description: 'Numero de page pour la pagination. Par defaut: 1'
				},
				per_page: {
					type: 'number',
					description: `Nombre de resultats par page (3-200). Par defaut: ${defaultPerPage}`
				}
			},
			required: ['q']
		}),
		execute: async (params): Promise<SearchPixabayResult> => {
			const msg = getMessages(locale);
			context.logger.info('Tool called', { query: params.q, params });

			const apiKey = context.env.PIXABAY_API_KEY;

			if (!apiKey) {
				context.logger.error('PIXABAY_API_KEY is not configured');
				return {
					message: msg.errorNotConfigured
				};
			}

			const searchParams = new URLSearchParams({
				key: apiKey,
				q: params.q,
				lang: params.lang || defaultLanguage,
				image_type: params.image_type || 'all',
				orientation: params.orientation || 'all',
				editors_choice: String(params.editors_choice || false),
				safesearch: String(params.safesearch !== undefined ? params.safesearch : safeSearch),
				order: params.order || 'popular',
				page: String(params.page || 1),
				per_page: String(params.per_page || defaultPerPage)
			});

			if (params.category) searchParams.set('category', params.category);
			if (params.min_width) searchParams.set('min_width', String(params.min_width));
			if (params.min_height) searchParams.set('min_height', String(params.min_height));
			if (params.colors) searchParams.set('colors', params.colors);

			try {
				const response = await fetch(`${PIXABAY_API_URL}?${searchParams.toString()}`);

				if (!response.ok) {
					context.logger.error('Pixabay API error', {
						status: response.status,
						statusText: response.statusText
					});
					return {
						message: msg.errorApiSearch('Pixabay', response.status, response.statusText)
					};
				}

				const data: PixabayResponse = await response.json();
				context.logger.info('Pixabay response received', { total: data.total, hits: data.hits.length });

				// Store images in MinIO
				const storedImages = await Promise.all(
					data.hits.map((img) => storeImageInMinio(img, context.storage, context.logger))
				);

				return formatImageResults(data, storedImages, locale);
			} catch (error) {
				context.logger.error('Error searching images', { error });
				return {
					message: msg.errorImageSearch(error instanceof Error ? error.message : 'Unknown error')
				};
			}
		}
	});
}
