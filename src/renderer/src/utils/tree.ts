import type { DirTree } from "../../../shared/types";
import { normalizePath } from "./path";

export interface TreemapRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function sortTreeChildren(node: DirTree): DirTree[] {
  return [...(node.children ?? [])].sort((a, b) => b.size - a.size);
}

function rangeSizeSum(values: number[], start: number, end: number): number {
  let sum = 0;
  for (let index = start; index < end; index += 1) {
    sum += values[index];
  }
  return sum;
}

export function buildTreemapRects(rawSizes: number[]): TreemapRect[] {
  const sizes = rawSizes.map((size) => (Number.isFinite(size) && size > 0 ? size : 1));
  const rects = sizes.map<TreemapRect>(() => ({ left: 0, top: 0, width: 0, height: 0 }));
  if (sizes.length === 0) {
    return rects;
  }

  const place = (start: number, end: number, left: number, top: number, width: number, height: number): void => {
    if (end - start <= 0) {
      return;
    }
    if (end - start === 1) {
      rects[start] = { left, top, width, height };
      return;
    }

    const total = rangeSizeSum(sizes, start, end);
    if (total <= 0) {
      const slice = width >= height ? width / (end - start) : height / (end - start);
      for (let index = start; index < end; index += 1) {
        const offset = slice * (index - start);
        rects[index] = width >= height
          ? { left: left + offset, top, width: slice, height }
          : { left, top: top + offset, width, height: slice };
      }
      return;
    }

    let running = 0;
    let split = start;
    while (split < end && running < total / 2) {
      running += sizes[split];
      split += 1;
    }
    if (split <= start) {
      split = start + 1;
    } else if (split >= end) {
      split = end - 1;
    }

    const firstTotal = rangeSizeSum(sizes, start, split);
    const ratio = firstTotal / total;
    if (width >= height) {
      const firstWidth = width * ratio;
      place(start, split, left, top, firstWidth, height);
      place(split, end, left + firstWidth, top, width - firstWidth, height);
    } else {
      const firstHeight = height * ratio;
      place(start, split, left, top, width, firstHeight);
      place(split, end, left, top + firstHeight, width, height - firstHeight);
    }
  };

  place(0, sizes.length, 0, 0, 100, 100);
  return rects;
}

export function findNodeByPath(root: DirTree, targetPath: string): DirTree | null {
  if (normalizePath(root.path) === normalizePath(targetPath)) {
    return root;
  }
  for (const child of root.children ?? []) {
    const hit = findNodeByPath(child, targetPath);
    if (hit) {
      return hit;
    }
  }
  return null;
}

export function findPathChain(root: DirTree, targetPath: string): DirTree[] {
  if (normalizePath(root.path) === normalizePath(targetPath)) {
    return [root];
  }
  for (const child of root.children ?? []) {
    const childChain = findPathChain(child, targetPath);
    if (childChain.length > 0) {
      return [root, ...childChain];
    }
  }
  return [];
}

export function resolveTreemapAutoFocusPath(root: DirTree): string {
  const targetDepth = 3;
  const maxDepth = 4;
  let current = root;
  let depth = 0;
  let result = root.path;

  while (depth < maxDepth) {
    const children = sortTreeChildren(current).filter((child) => child.size > 0);
    if (children.length === 0) {
      break;
    }

    const largest = children[0];
    const total = current.size > 0 ? current.size : children.reduce((sum, child) => sum + child.size, 0);
    const share = total > 0 ? largest.size / total : 0;
    const nextDepth = depth + 1;

    if (nextDepth > targetDepth && share < 0.7) {
      break;
    }

    result = largest.path;
    current = largest;
    depth = nextDepth;
  }

  return result;
}

export function countSubDirectories(node: DirTree): number {
  let count = 0;
  const stack: DirTree[] = [...(node.children ?? [])];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    count += 1;
    const children = current.children ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push(children[index]);
    }
  }
  return count;
}
