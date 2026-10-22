/**
 * DOM traversal that sees through open shadow roots.
 *
 * Component libraries built on web components (Ionic, Shoelace, Lightning,
 * Material Web) render their radio buttons inside a shadow root, where
 * `querySelectorAll`, `parentElement` and `contains` all stop at the boundary.
 * These helpers walk the composed tree instead - the tree the user actually
 * sees - so a control three components deep is found, grouped and clicked
 * like any other. Closed shadow roots are, by design, out of reach.
 */

/** The parent in the composed tree: a shadow root's top element yields its host. */
export function composedParent(node: Element): Element | null {
  if (node.parentElement) return node.parentElement;
  const parent = node.parentNode;
  // `host` identifies a ShadowRoot without relying on the global constructor,
  // which differs between a content script's world and the page's.
  return parent && 'host' in parent ? ((parent as ShadowRoot).host ?? null) : null;
}

/** `ancestor.contains(node)`, across shadow boundaries. */
export function composedContains(ancestor: Element, node: Element): boolean {
  for (let current: Element | null = node; current; current = composedParent(current)) {
    if (current === ancestor) return true;
  }
  return false;
}

/** `root` plus every open shadow root beneath it, nested ones included. */
export function searchRoots(root: ParentNode): ParentNode[] {
  const roots: ParentNode[] = [root];
  for (let index = 0; index < roots.length; index += 1) {
    const current = roots[index] as ParentNode;
    for (const element of Array.from(current.querySelectorAll('*'))) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  return roots;
}

/**
 * `querySelectorAll` over `root` and every open shadow root beneath it - or
 * over `searchRoots` computed once already, when several queries share them.
 */
export function queryAllDeep<T extends Element>(
  root: ParentNode | readonly ParentNode[],
  selector: string,
): T[] {
  const scopes = Array.isArray(root) ? (root as readonly ParentNode[]) : searchRoots(root as ParentNode);
  return scopes.flatMap((scope) => Array.from(scope.querySelectorAll(selector)) as T[]);
}

/** The lowest element that contains all of `elements`, across shadow boundaries. */
export function lowestCommonAncestor(elements: readonly Element[]): Element | null {
  const [first, ...rest] = elements;
  if (!first) return null;

  for (let ancestor = composedParent(first); ancestor; ancestor = composedParent(ancestor)) {
    if (rest.every((element) => composedContains(ancestor as Element, element))) return ancestor;
  }
  return null;
}
