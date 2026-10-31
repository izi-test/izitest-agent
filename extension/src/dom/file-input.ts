// Files given to an <input type="file"> from inside the page, as a person picking them in
// the dialog would: the input gets them through a DataTransfer, then input and change are
// sent. Chrome's own way, DOM.setFileInputFiles, is refused to an extension unless it is
// allowed file URLs (off by default), and reads the files where Chrome runs; this takes
// their content, sent by the server, and needs no permission.

export interface FileData {
  name: string;
  type: string;
  base64: string;
}

/**
 * The file input `el` stands for: itself; the one its <label> is for; or the only one in it
 * or in its closest ancestor that has any — a drop zone hides its input inside, an "Upload"
 * button sits next to the hidden input it clicks. Null when there is none, or two at the
 * level where one is found.
 *
 * Self-contained: replay runs it in the page with evaluateHandle().
 */
export function fileInputOf(el: Element): HTMLInputElement | null {
  const isFileInput = (node: Element | null): node is HTMLInputElement =>
    !!node && node.tagName === 'INPUT' && (node as HTMLInputElement).type === 'file';
  if (isFileInput(el)) return el;
  const control = el.tagName === 'LABEL' ? (el as HTMLLabelElement).control : null;
  if (isFileInput(control)) return control;
  let node: Element | null = el;
  for (let level = 0; node && level < 4; level++, node = node.parentElement) {
    const inside = node.querySelectorAll('input[type="file"]');
    if (inside.length) return inside.length === 1 ? (inside[0] as HTMLInputElement) : null;
  }
  return null;
}

/**
 * Put `files` in the input, in place of what it held, and tell the page. The names it then
 * holds, or why not.
 *
 * Self-contained: replay runs it in the page with handle.evaluate().
 */
export function putFiles(el: Element, files: FileData[]): { names: string[] } | { error: string } {
  const input = el as HTMLInputElement;
  if (files.length > 1 && !input.multiple) {
    return { error: `This file input takes one file, not ${files.length} (it has no "multiple")` };
  }
  const transfer = new DataTransfer();
  for (const file of files) {
    const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
    transfer.items.add(new File([bytes], file.name, { type: file.type }));
  }
  input.files = transfer.files;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return { names: Array.from(transfer.files).map((file) => file.name) };
}
