// Hold Space over a scrolling area and drag to move around it, as in design tools. The area
// scrolls (with its scrollbars hidden), so the mouse wheel and trackpad move around it too.
//
// While Space is held, a press and drag on the area only pans: these listeners run first (on
// window, capturing) and keep the press, the moves and the click that ends it from everything
// under the pointer (the cards). `scale()` is how much the area's own scroll is zoomed (a canvas
// zoomed with CSS zoom scrolls in unzoomed pixels), so the content follows the pointer. Returns
// {isHeld}.

export function panWithSpace(area, { scale = () => 1 } = {}) {
  let over = false;       // the pointer is over the area
  let held = false;       // Space is down, over the area
  let pan = null;         // the drag: where it started, and the scroll then
  let endingPan = false;  // the click that ends a drag is the drag's, not a click

  area.addEventListener("mouseenter", () => { over = true; });
  area.addEventListener("mouseleave", () => { over = false; });
  const stop = () => {
    held = false;
    pan = null;
    area.classList.remove("pan-ready", "panning");
  };

  window.addEventListener("keydown", (e) => {
    if (e.code !== "Space" || !over || e.target.closest?.("input, textarea, select, [contenteditable]")) return;
    e.preventDefault();  // not a page scroll or a button press
    held = true;
    area.classList.add("pan-ready");
  });
  window.addEventListener("keyup", (e) => { if (e.code === "Space") stop(); });
  window.addEventListener("blur", stop);

  window.addEventListener("mousedown", (e) => {
    if (!held || !area.contains(e.target)) return;
    pan = { x: e.clientX, y: e.clientY, left: area.scrollLeft, top: area.scrollTop };
    area.classList.add("panning");
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
  window.addEventListener("mousemove", (e) => {
    if (!pan) return;
    area.scrollLeft = pan.left - (e.clientX - pan.x) / scale();
    area.scrollTop = pan.top - (e.clientY - pan.y) / scale();
    e.stopImmediatePropagation();
  }, true);
  window.addEventListener("mouseup", (e) => {
    if (!pan) return;
    pan = null;
    area.classList.remove("panning");
    e.stopImmediatePropagation();
    endingPan = true;
    setTimeout(() => { endingPan = false; });  // in case no click follows
  }, true);
  window.addEventListener("click", (e) => {
    if (!endingPan) return;
    endingPan = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  return { isHeld: () => held };
}
