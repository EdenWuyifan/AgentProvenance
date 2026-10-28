/** Export the mounted graph at native layout size, independent of screen zoom. */
export async function exportGraphPng(root: HTMLElement, scale = 3) {
  await document.fonts.ready;
  const viewport = root.querySelector<HTMLElement>('.react-flow__viewport')!;
  const flow = root.querySelector<HTMLElement>('.react-flow')!;
  const matrix = new DOMMatrix(getComputedStyle(viewport).transform);
  const origin = flow.getBoundingClientRect();
  const boxes = [...viewport.querySelectorAll('.react-flow__node, .react-flow__edge-path')]
    .map((element) => element.getBoundingClientRect());
  const left = Math.floor((Math.min(...boxes.map((box) => box.left)) - origin.left - matrix.e) / matrix.a) - 32;
  const top = Math.floor((Math.min(...boxes.map((box) => box.top)) - origin.top - matrix.f) / matrix.d) - 32;
  const right = Math.ceil((Math.max(...boxes.map((box) => box.right)) - origin.left - matrix.e) / matrix.a) + 32;
  const bottom = Math.ceil((Math.max(...boxes.map((box) => box.bottom)) - origin.top - matrix.f) / matrix.d) + 32;
  const width = right - left, height = bottom - top;
  const clone = viewport.cloneNode(true) as HTMLElement;
  const originals = [viewport, ...viewport.querySelectorAll('*')];
  const copies = [clone, ...clone.querySelectorAll('*')];
  originals.forEach((element, index) => {
    const style = getComputedStyle(element);
    (copies[index] as HTMLElement | SVGElement).style.cssText = Array.from(style)
      .map((property) => `${property}:${style.getPropertyValue(property)};`).join('');
  });
  Object.assign(clone.style, {transform: `translate(${-left}px, ${-top}px)`, width: `${width}px`, height: `${height}px`});
  const content = new XMLSerializer().serializeToString(clone);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/><foreignObject width="100%" height="100%">${content}</foreignObject></svg>`;
  const image = new Image();
  image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = width * scale; canvas.height = height * scale;
  const context = canvas.getContext('2d')!;
  context.scale(scale, scale); context.drawImage(image, 0, 0);
  return {url: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height};
}
