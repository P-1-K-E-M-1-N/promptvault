// Streams the elements of a top-level JSON array one at a time, so a
// multi-hundred-MB export (ChatGPT conversations.json, Gemini MyActivity.json)
// never has to sit in memory as a single string.
//
// If the document is an object instead of an array, it is parsed whole and
// the first array-valued property is streamed (some exports wrap the list).

import { StringDecoder } from 'node:string_decoder';

export async function* streamJsonArray(readable) {
  const decoder = new StringDecoder('utf8');
  let mode = null; // 'array' | 'object'
  let depth = 0;
  let inStr = false;
  let esc = false;
  let inElem = false;
  let parts = [];
  const whole = [];

  for await (const raw of readable) {
    let chunk = typeof raw === 'string' ? raw : decoder.write(raw);
    let i = 0;

    if (mode === null) {
      // Skip BOM and leading whitespace.
      while (i < chunk.length && (chunk.charCodeAt(i) === 0xfeff || /\s/.test(chunk[i]))) i++;
      if (i === chunk.length) continue;
      if (chunk[i] === '[') { mode = 'array'; depth = 1; i++; }
      else if (chunk[i] === '{') { mode = 'object'; }
      else throw new Error('Not a JSON array or object');
    }
    if (mode === 'object') { whole.push(chunk.slice(i)); continue; }

    let start = inElem ? 0 : -1;
    for (; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i);
      if (inStr) {
        if (esc) esc = false;
        else if (c === 92) esc = true; // backslash
        else if (c === 34) inStr = false; // quote
        continue;
      }
      if (c === 34) { inStr = true; continue; }
      if (c === 123 || c === 91) { // { or [
        if (depth === 1) { start = i; inElem = true; }
        depth++;
      } else if (c === 125 || c === 93) { // } or ]
        depth--;
        if (depth === 1 && inElem) {
          parts.push(chunk.slice(start, i + 1));
          const text = parts.join('');
          parts = [];
          inElem = false;
          start = -1;
          yield JSON.parse(text);
        } else if (depth === 0) {
          return;
        }
      }
    }
    if (inElem) parts.push(chunk.slice(start));
  }

  if (mode === 'object') {
    const obj = JSON.parse(whole.join('') + decoder.end());
    const arr = Object.values(obj).find(Array.isArray);
    if (arr) for (const item of arr) yield item;
  }
}
