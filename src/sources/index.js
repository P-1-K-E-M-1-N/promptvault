// The source registry. To add a source, write one plugin file in this folder and
// add it to this list. See CONTRIBUTING.md → "Add a new source in 30 minutes".

import claudeCode from './claude-code.js';
import chatgpt from './chatgpt-export.js';
import claudeExport from './claude-export.js';
import gemini from './gemini-takeout.js';

export const sources = [claudeCode, chatgpt, claudeExport, gemini];

export const KINDS = ['user_prompt', 'assistant_reply', 'tool_call', 'tool_result'];

export function getSource(id) {
  return sources.find((s) => s.id === id);
}
