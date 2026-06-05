/**
 * Protection SSRF (Server-Side Request Forgery) pour l'outil fetch_url.
 *
 * Sans ce garde-fou, le LLM peut fetcher n'importe quelle URL — y compris des
 * services internes du reseau Docker (ex: seaweedfs-master-xxx:9333) ou des
 * endpoints de metadonnees cloud (169.254.169.254) — et exfiltrer des donnees
 * d'autres utilisateurs.
 *
 * Strategie : on n'autorise que http/https vers des adresses PUBLIQUES. Tout
 * hostname est resolu en DNS et chaque IP obtenue est verifiee contre les plages
 * privees / loopback / link-local / reservees. Les redirections sont suivies
 * manuellement et revalidees a chaque saut.
 */
import { lookup } from 'node:dns/promises';
import net from 'node:net';

export class SsrfError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SsrfError';
	}
}

// Plages IPv4 non routables / a usage special (RFC 1918, RFC 6890, etc.)
const BLOCKED_V4: Array<[string, number, string]> = [
	['0.0.0.0', 8, 'this-network'],
	['10.0.0.0', 8, 'private'],
	['100.64.0.0', 10, 'cgnat'],
	['127.0.0.0', 8, 'loopback'],
	['169.254.0.0', 16, 'link-local'], // metadonnees cloud (169.254.169.254)
	['172.16.0.0', 12, 'private'], // reseaux Docker par defaut
	['192.0.0.0', 24, 'ietf'],
	['192.0.2.0', 24, 'test-net'],
	['192.88.99.0', 24, '6to4-relay'],
	['192.168.0.0', 16, 'private'],
	['198.18.0.0', 15, 'benchmark'],
	['198.51.100.0', 24, 'test-net'],
	['203.0.113.0', 24, 'test-net'],
	['224.0.0.0', 4, 'multicast'],
	['240.0.0.0', 4, 'reserved'],
	['255.255.255.255', 32, 'broadcast']
];

function v4ToInt(ip: string): number {
	const parts = ip.split('.');
	return ((Number(parts[0]) << 24) | (Number(parts[1]) << 16) | (Number(parts[2]) << 8) | Number(parts[3])) >>> 0;
}

function v4BlockedReason(ip: string): string | null {
	const value = v4ToInt(ip);
	for (const [base, bits, reason] of BLOCKED_V4) {
		const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
		if ((value & mask) === (v4ToInt(base) & mask)) return reason;
	}
	return null;
}

/** Convertit une adresse IPv6 (avec :: et IPv4 embarque) en 16 octets. */
function v6ToBytes(addr: string): number[] | null {
	addr = addr.split('%')[0].toLowerCase(); // retire l'eventuelle zone (%eth0)

	// Convertit un suffixe IPv4 (ex: ::ffff:127.0.0.1) en deux hextets.
	const v4 = addr.match(/:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
	if (v4) {
		const o = v4[1].split('.').map(Number);
		if (o.length !== 4 || o.some((n) => Number.isNaN(n) || n > 255)) return null;
		const hex = `${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
		addr = addr.slice(0, addr.length - v4[1].length) + hex;
	}

	const halves = addr.split('::');
	if (halves.length > 2) return null;
	const parse = (s: string) => (s ? s.split(':').map((h) => parseInt(h, 16)) : []);
	const left = parse(halves[0]);
	const right = halves.length === 2 ? parse(halves[1]) : [];

	let groups: number[];
	if (halves.length === 2) {
		const missing = 8 - left.length - right.length;
		if (missing < 0) return null;
		groups = [...left, ...new Array(missing).fill(0), ...right];
	} else {
		groups = left;
	}

	if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g < 0 || g > 0xffff)) return null;
	const bytes: number[] = [];
	for (const g of groups) bytes.push(g >> 8, g & 0xff);
	return bytes;
}

function v6BlockedReason(addr: string): string | null {
	const b = v6ToBytes(addr);
	if (!b) return 'invalid';

	if (b.every((x) => x === 0)) return 'unspecified'; // ::
	if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return 'loopback'; // ::1

	// IPv4-mapped ::ffff:a.b.c.d  -> on valide l'IPv4 embarquee
	if (b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff) {
		return v4BlockedReason(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
	}
	// NAT64 64:ff9b::/96 -> idem
	if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
		return v4BlockedReason(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`) ?? 'nat64';
	}
	if ((b[0] & 0xfe) === 0xfc) return 'unique-local'; // fc00::/7
	if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return 'link-local'; // fe80::/10
	if (b[0] === 0xff) return 'multicast'; // ff00::/8
	if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return 'documentation'; // 2001:db8::/32
	return null;
}

/** Retourne la raison du blocage d'une IP (string) ou null si publique/autorisee. */
export function ipBlockedReason(ip: string): string | null {
	const family = net.isIP(ip);
	if (family === 4) return v4BlockedReason(ip);
	if (family === 6) return v6BlockedReason(ip);
	return 'not-an-ip';
}

/**
 * Valide une URL et resout son hostname. Leve SsrfError si le schema n'est pas
 * http(s) ou si une des IP resolues pointe vers un reseau interne/reserve.
 */
export async function assertSafeUrl(raw: string): Promise<URL> {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new SsrfError(`URL invalide: ${raw}`);
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new SsrfError(`Schema non autorise: ${url.protocol} (seuls http/https sont permis)`);
	}

	const host = url.hostname.replace(/^\[|\]$/g, ''); // retire les crochets IPv6
	let addresses: string[];

	if (net.isIP(host)) {
		addresses = [host];
	} else {
		let resolved;
		try {
			resolved = await lookup(host, { all: true });
		} catch {
			throw new SsrfError(`Resolution DNS impossible pour ${host}`);
		}
		if (resolved.length === 0) throw new SsrfError(`Aucune adresse pour ${host}`);
		addresses = resolved.map((r) => r.address);
	}

	for (const ip of addresses) {
		const reason = ipBlockedReason(ip);
		if (reason) {
			throw new SsrfError(`Acces a une adresse interne/reservee bloque (${host} -> ${ip} : ${reason})`);
		}
	}

	return url;
}

/**
 * fetch securise : valide l'URL initiale puis suit les redirections
 * manuellement en revalidant chaque saut (empeche le contournement par
 * redirection vers une IP interne).
 */
export async function safeFetch(
	raw: string,
	init: RequestInit = {},
	maxRedirects = 5
): Promise<Response> {
	let current = raw;
	for (let hop = 0; hop <= maxRedirects; hop++) {
		const url = await assertSafeUrl(current);
		const response = await fetch(url, { ...init, redirect: 'manual' });

		const location = response.headers.get('location');
		if (response.status >= 300 && response.status < 400 && location) {
			current = new URL(location, url).toString();
			continue;
		}
		return response;
	}
	throw new SsrfError(`Trop de redirections (> ${maxRedirects})`);
}
