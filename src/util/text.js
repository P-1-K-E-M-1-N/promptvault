// Small text helpers shared by source plugins.

export function truncate(text, max) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return text.slice(0, max) + `\n… [truncated ${text.length - max} chars]`;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

export function htmlToText(html) {
  if (typeof html !== 'string') return '';
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|pre)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function firstLine(text, max = 90) {
  const line = String(text || '').trim().split('\n').find((l) => l.trim()) || '';
  return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line.trim();
}

export function toMs(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return value < 1e11 ? Math.round(value * 1000) : Math.round(value); // seconds vs ms
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

// Read up to `max` bytes from the start of a stream (used to sniff file types).
export async function readHead(stream, max = 65536) {
  const chunks = [];
  let len = 0;
  try {
    for await (const chunk of stream) {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      chunks.push(buf);
      len += buf.length;
      if (len >= max) break;
    }
  } finally {
    stream.destroy?.();
  }
  return Buffer.concat(chunks).subarray(0, max).toString('utf8');
}
