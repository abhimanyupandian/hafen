// Copy text to the clipboard. The Clipboard API needs a secure page (https or localhost); a page
// opened by its network address (http://192.168…) falls back to the older copy command.
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const box = Object.assign(document.createElement("textarea"), { value: text });
    box.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.append(box);
    box.select();
    const copied = document.execCommand("copy");
    box.remove();
    return copied;
  }
}
