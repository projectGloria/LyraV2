function intersectionArea(first, second) {
  const width = Math.max(0, Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x));
  const height = Math.max(0, Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y));
  return width * height;
}

function isFiniteBounds(bounds) {
  return bounds
    && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(Number(bounds[key])))
    && Number(bounds.width) > 0
    && Number(bounds.height) > 0;
}

function isWindowAccessible(bounds, displays) {
  if (!isFiniteBounds(bounds)) return false;
  const titleBar = { x: Number(bounds.x), y: Number(bounds.y), width: Number(bounds.width), height: Math.min(64, Number(bounds.height)) };
  return displays.some((display) => intersectionArea(titleBar, display.workArea) >= 80 * 30);
}

function fitBoundsToDisplays(savedBounds, defaults, electronScreen) {
  const width = Math.max(defaults.minWidth || 1, Number(savedBounds?.width) || defaults.width);
  const height = Math.max(defaults.minHeight || 1, Number(savedBounds?.height) || defaults.height);
  const candidate = {
    width,
    height,
    ...(Number.isFinite(Number(savedBounds?.x)) ? { x: Number(savedBounds.x) } : {}),
    ...(Number.isFinite(Number(savedBounds?.y)) ? { y: Number(savedBounds.y) } : {})
  };
  const displays = electronScreen.getAllDisplays();

  if (!Object.hasOwn(candidate, 'x') || !Object.hasOwn(candidate, 'y')) return candidate;
  if (isWindowAccessible(candidate, displays)) return candidate;

  const workArea = electronScreen.getPrimaryDisplay().workArea;
  const fittedWidth = Math.min(width, workArea.width);
  const fittedHeight = Math.min(height, workArea.height);
  return {
    width: fittedWidth,
    height: fittedHeight,
    x: workArea.x + Math.round((workArea.width - fittedWidth) / 2),
    y: workArea.y + Math.round((workArea.height - fittedHeight) / 2)
  };
}

module.exports = { fitBoundsToDisplays, isWindowAccessible };
