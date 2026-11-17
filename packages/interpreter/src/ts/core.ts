// The root interpreter class that holds state about the mapping between DOM and VirtualDom
// This always lives in the JS side of things, and is extended by the native and web interpreters

import { setAttributeInner } from "./set_attribute";

export type NodeId = number;

// Attribute set by the renderer on an element that must own a shadow root.
export const SHADOW_ATTRIBUTE = "data-dioxus-shadow";

// Attribute that makes an element stand in for the document's scroller: `data-dioxus-scroll-proxy`
// = "document". Standard Dioxus can only observe and drive an element's scroll, but some UI must
// scroll the document itself (a nested `overflow: auto` element gets no momentum scrolling in
// some engines, WebKitGTK among them). On a proxy element:
//   - `scroll`/`scrollend` listeners receive the window's scroll, and the event data (see
//     `serializeScrollEvent`) is read from `document.scrollingElement`;
//   - `resize` listeners receive the viewport's size, observed on a fixed full-viewport
//     sentinel, so the entry's boxes are the viewport's (what the document scroller's
//     client box is);
//   - the mounted scroll commands (`native.ts`) act on the document scroller.
// The proxy element itself needs no scroll or size of its own.
export const SCROLL_PROXY_ATTRIBUTE = "data-dioxus-scroll-proxy";
const VIEWPORT_SCROLL_EVENTS = ["scroll", "scrollend"];

// Host styles in shadow roots.
//
// A shadow root hides the document's stylesheets from its subtree, so a micro that styles itself
// with the host's utility classes (the kit/Tailwind bundle and theme) would render unstyled.
// Every mount's root therefore adopts the host's stylesheets as constructable sheets. There is
// ONE shared set, not a copy per mount: `adoptedStyleSheets` holds references, and rebuilding a
// shared sheet with `replaceSync` restyles every mount at once.
//
// Cascade, lowest to highest precedence:
//   1. `@layer kit`: every rule of the host document's sheets. Layered rules lose to every
//      unlayered rule, so
//   2. the micro's own sanitized `<style>` inside the shadow root (unlayered) beats the kit;
//   3. USER_SHEET, the seam for a user stylesheet that comes last. It would be adopted unlayered
//      after the kit (adopted sheets follow the root's own `<style>` elements in the cascade), so
//      it beats both. It is not built yet: `hostSheets` returns only the kit for now.
// `@layer kit, user;` is declared first so a future `@layer user` block outranks the kit
// whatever order it arrives in.
//
// The flow is one way: the shared sheets are only ever adopted INTO shadow roots, so a micro's
// CSS (inside its root) never reaches the document or another mount.
export const KIT_LAYER = "kit";
let kitSheet: CSSStyleSheet | undefined;
let kitDirty = true;

// Flattens a sheet's rules to text, following `@import` into the imported sheet (which
// `replaceSync` would refuse as an `@import`). A sheet whose rules the browser withholds
// (cross-origin without CORS) cannot be adopted by any means, so it is skipped.
function sheetText(sheet: CSSStyleSheet): string {
  let rules: CSSRuleList;
  try {
    rules = sheet.cssRules;
  } catch {
    return "";
  }
  let text = "";
  for (const rule of Array.from(rules)) {
    text +=
      rule instanceof CSSImportRule && rule.styleSheet
        ? sheetText(rule.styleSheet)
        : rule.cssText;
    text += "\n";
  }
  return text;
}

function rebuildKit() {
  const text = Array.from(document.styleSheets, sheetText).join("");
  kitSheet ??= new CSSStyleSheet();
  kitSheet.replaceSync(`@layer ${KIT_LAYER}, user;\n@layer ${KIT_LAYER} {\n${text}}`);
  kitDirty = false;
}

// A sheet appearing, disappearing or finishing loading marks the kit dirty; the rebuild runs
// once per burst, in a microtask. Only `<head>` (and the root's direct children) is watched:
// sheets belong there, and watching the whole document would fire on every UI mutation.
let rebuildQueued = false;
function markKitDirty() {
  kitDirty = true;
  if (rebuildQueued) return;
  rebuildQueued = true;
  queueMicrotask(() => {
    rebuildQueued = false;
    rebuildKit();
  });
}
// Starts watching on first use, not at load: the bundle may be evaluated before the document
// has a `<head>` (a webview's initialization script), and an unused interpreter costs nothing.
let kitWatching = false;
function watchKit() {
  if (kitWatching) return;
  kitWatching = true;
  const sheetObserver = new MutationObserver(markKitDirty);
  sheetObserver.observe(document.documentElement, { childList: true });
  sheetObserver.observe(document.head, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["href", "media", "disabled"],
  });
  // A `<link>` adds its rules when it finishes loading, which is after it was inserted.
  document.addEventListener(
    "load",
    (event) => {
      if (event.target instanceof HTMLLinkElement) markKitDirty();
    },
    true,
  );
}

function hostSheets(): CSSStyleSheet[] {
  watchKit();
  if (kitDirty) rebuildKit();
  return [kitSheet as CSSStyleSheet];
}

// The node that holds `node`'s children: its shadow root when it has one,
// otherwise `node` itself.
export function childContainer(node: Node): Node {
  return (node as Element).shadowRoot ?? node;
}

// Element decorated with the listener bookkeeping properties that the
// interpreter attaches at runtime.
interface ListenerElement extends Element {
  listening?: number;
}

// A stack entry pairs a DOM node with the ElementId it was pushed under, or
// `null` for nodes pushed positionally (e.g. cloned template children).
type StackEntry = [Node, NodeId | null];

export class BaseInterpreter {
  // non bubbling events listen at the element the listener was created at
  global: {
    [key: string]: { active: number; callback: EventListener };
  };
  // bubbling events can listen at the root element
  local: {
    [key: string]: {
      [key: string]: EventListener;
    };
  };

  root: HTMLElement;
  handler: EventListener;
  resizeObserver: ResizeObserver;
  intersectionObserver: IntersectionObserver;

  // Elements marked `SCROLL_PROXY_ATTRIBUTE` that have a listener, fed by the window's scroll and
  // the viewport sentinel's size. The window listener and the sentinel exist only while this is
  // non-empty.
  scrollProxies: Set<Element>;
  viewportSentinel: HTMLElement | undefined;
  viewportScrollHandler: EventListener | undefined;

  nodes: Node[];
  stack: StackEntry[];

  // sledgehammer is generating this...
  m: any;

  constructor() {}

  initialize(root: HTMLElement, handler: EventListener | null = null) {
    this.global = {};
    this.local = {};
    this.scrollProxies = new Set();
    this.root = root;

    this.nodes = [root];
    this.stack = [[root, 0]];

    this.handler = handler;

    // make sure to set the root element's ID so it still registers events
    root.setAttribute("data-dioxus-id", "0");
  }

  handleResizeEvent(entry: ResizeObserverEntry) {
    // The sentinel's size is the viewport's: every proxy receives it as its own.
    const targets =
      entry.target === this.viewportSentinel
        ? this.liveScrollProxies()
        : [entry.target];

    for (const target of targets) {
      target.dispatchEvent(
        new CustomEvent<ResizeObserverEntry>("resize", {
          bubbles: false,
          detail: entry,
        }),
      );
    }
  }

  // The registered proxies still in the document. A removed element's listeners are dropped with
  // it, but a subtree removed under it never reports each node, so disconnection is the signal.
  liveScrollProxies(): Element[] {
    for (const proxy of this.scrollProxies) {
      if (!proxy.isConnected) this.scrollProxies.delete(proxy);
    }
    if (this.scrollProxies.size === 0) this.stopViewportWatch();
    return Array.from(this.scrollProxies);
  }

  registerScrollProxy(element: Element) {
    if (this.scrollProxies.has(element)) return;
    this.scrollProxies.add(element);
    if (this.viewportScrollHandler) return;
    this.viewportScrollHandler = (event) => {
      for (const proxy of this.liveScrollProxies()) {
        proxy.dispatchEvent(new Event(event.type, { bubbles: false }));
      }
    };
    for (const name of VIEWPORT_SCROLL_EVENTS) {
      window.addEventListener(name, this.viewportScrollHandler, {
        passive: true,
      });
    }
    // `position: fixed` with every inset 0 spans the viewport less its scrollbars, which is the
    // document scroller's client box.
    const sentinel = document.createElement("div");
    sentinel.setAttribute("aria-hidden", "true");
    sentinel.style.cssText =
      "position:fixed;inset:0;visibility:hidden;pointer-events:none;";
    document.body.append(sentinel);
    this.viewportSentinel = sentinel;
    this.observeViewport();
  }

  // Observing delivers an initial entry, so a proxy gets its size once it listens, however late.
  observeViewport() {
    this.createResizeObserver(this.viewportSentinel!);
  }

  stopViewportWatch() {
    for (const name of VIEWPORT_SCROLL_EVENTS) {
      window.removeEventListener(name, this.viewportScrollHandler!);
    }
    this.viewportScrollHandler = undefined;
    this.resizeObserver.unobserve(this.viewportSentinel!);
    this.viewportSentinel!.remove();
    this.viewportSentinel = undefined;
  }

  createResizeObserver(element: Element) {
    // Lazily create the resize observer
    if (!this.resizeObserver) {
      this.resizeObserver = new ResizeObserver((entries) => {
        for (const entry of entries) {
          this.handleResizeEvent(entry);
        }
      });
    }
    // Re-observing restarts the initial notification: a listener added later still gets a size.
    this.resizeObserver.unobserve(element);
    this.resizeObserver.observe(element);
  }

  removeResizeObserver(element: Element) {
    if (this.resizeObserver && !this.scrollProxies.has(element)) {
      this.resizeObserver.unobserve(element);
    }
  }

  handleIntersectionEvent(entry: IntersectionObserverEntry) {
    const target = entry.target;

    let event = new CustomEvent<IntersectionObserverEntry>("visible", {
      bubbles: false,
      detail: entry,
    });

    target.dispatchEvent(event);
  }

  createIntersectionObserver(element: Element) {
    /// Lazily create the intersection observer
    if (!this.intersectionObserver) {
      this.intersectionObserver = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          this.handleIntersectionEvent(entry);
        }
      });
    }
    this.intersectionObserver.observe(element);
  }

  removeIntersectionObserver(element: Element) {
    if (this.intersectionObserver) {
      this.intersectionObserver.unobserve(element);
    }
  }

  createListener(event_name: string, element: Element, bubbles: boolean) {
    const proxy = element.hasAttribute(SCROLL_PROXY_ATTRIBUTE);
    if (proxy) {
      this.registerScrollProxy(element);
    }
    if (event_name == "resize") {
      // A proxy's size is the sentinel's, delivered by `registerScrollProxy`.
      if (proxy) this.observeViewport();
      else this.createResizeObserver(element);
    } else if (event_name == "visible") {
      this.createIntersectionObserver(element);
    }

    if (bubbles) {
      if (this.global[event_name] === undefined) {
        this.global[event_name] = { active: 1, callback: this.handler };
        this.root.addEventListener(event_name, this.handler);
      } else {
        this.global[event_name].active++;
      }
    } else {
      const id = element.getAttribute("data-dioxus-id");
      if (!this.local[id]) {
        this.local[id] = {};
      }
      element.addEventListener(event_name, this.handler);
    }
  }

  removeListener(element: Element, event_name: string, bubbles: boolean) {
    if (event_name == "resize") {
      this.removeResizeObserver(element);
    } else if (event_name == "visible") {
      this.removeIntersectionObserver(element);
    } else if (bubbles) {
      this.removeBubblingListener(event_name);
    } else {
      this.removeNonBubblingListener(element, event_name);
    }
  }

  removeBubblingListener(event_name: string) {
    this.global[event_name].active--;
    if (this.global[event_name].active === 0) {
      this.root.removeEventListener(
        event_name,
        this.global[event_name].callback,
      );
      delete this.global[event_name];
    }
  }

  removeNonBubblingListener(element: Element, event_name: string) {
    const id = element.getAttribute("data-dioxus-id");
    delete this.local[id][event_name];
    if (Object.keys(this.local[id]).length === 0) {
      delete this.local[id];
    }
    element.removeEventListener(event_name, this.handler);
  }

  removeAllNonBubblingListeners(element: Element) {
    this.scrollProxies.delete(element);
    const id = element.getAttribute("data-dioxus-id");
    delete this.local[id];
  }

  getNode(id: NodeId): Node {
    return this.nodes[id];
  }

  // Bind an ElementId to a DOM node. Used by the Rust hydration cursor to
  // record the nodes it matches against the server-rendered DOM.
  setNode(id: NodeId, node: Node) {
    this.nodes[id] = node;
  }

  // Attach an event listener to a previously-bound node. Mirrors
  // `addTopEventListener`, but addresses the element by id rather than the
  // working stack, so the Rust hydration cursor can drive it directly.
  setNodeListener(id: NodeId, event_name: string, bubbles: boolean) {
    const node = this.nodes[id] as ListenerElement;
    if (node.listening) node.listening += 1;
    else node.listening = 1;
    node.setAttribute("data-dioxus-id", `${id}`);
    this.createListener(event_name, node, bubbles);
  }

  pushRoot(node: Node) {
    this.stack.push([node, null]);
  }

  pushId(id: NodeId) {
    this.stack.push([this.nodes[id], id]);
  }

  popId(id: NodeId) {
    const entry = this.stack.pop();
    if (!entry) throw new Error("popId: empty stack");
    this.nodes[id] = entry[0];
  }

  setId(id: NodeId) {
    const top = this.stack[this.stack.length - 1];
    if (!top) throw new Error("setId: empty stack");
    this.nodes[id] = top[0];
    top[1] = id;
  }

  currentTopId(): NodeId {
    const id = this.stack[this.stack.length - 1][1];
    if (id == null) throw new Error("currentTopId: top node has no ElementId");
    return id;
  }

  child(index: number) {
    const parent = childContainer(this.stack[this.stack.length - 1][0]);
    const child = parent.childNodes[index];
    if (!child) throw new Error("child: index out of bounds");
    this.stack[this.stack.length - 1] = [child, null];
  }

  pop() {
    this.stack.pop();
  }

  createElementTop(tag: string, ns: string | null) {
    this.stack.push([
      ns ? document.createElementNS(ns, tag) : document.createElement(tag),
      null,
    ]);
  }

  createTextTop(text: string) {
    this.stack.push([document.createTextNode(text), null]);
  }

  cloneTop() {
    const node = this.stack[this.stack.length - 1][0];
    this.stack[this.stack.length - 1] = [this.cloneDeep(node), null];
  }

  // `cloneNode(true)` copies light children only, which would leave a cloned
  // shadow host with an empty shadow root (or none at all). Templates whose
  // subtree contains a shadow host are cloned by hand; others take the native
  // fast path.
  cloneDeep(node: Node): Node {
    if (
      !(node instanceof Element) ||
      !(node.shadowRoot || node.querySelector(`[${SHADOW_ATTRIBUTE}]`))
    ) {
      return node.cloneNode(true);
    }
    const copy = node.cloneNode(false) as Element;
    const into = copy.hasAttribute(SHADOW_ATTRIBUTE)
      ? this.ensureShadowRoot(copy)
      : copy;
    for (const child of childContainer(node).childNodes) {
      into.appendChild(this.cloneDeep(child));
    }
    return copy;
  }

  // Give `node` its shadow root if it is marked with `data-dioxus-shadow`.
  //
  // The mark is a plain attribute: the renderer emits it as a SetAttribute
  // after CreateElement, so the element does not yet carry it when it is
  // created, and children arrive after it in the same batch. We therefore
  // attach when the attribute is set (see `setAttributeInner`) and again,
  // idempotently, when children are inserted. If children landed first, they
  // are moved into the shadow root so that the light DOM of a host is always
  // empty. The mode is "open" because the event path (`composedPath`) of
  // closed roots is hidden from the root listener.
  ensureShadowRoot(node: Node): Node {
    const element = node as Element;
    if (element.shadowRoot) return element.shadowRoot;
    if (!element.hasAttribute?.(SHADOW_ATTRIBUTE)) return node;
    const shadow = element.attachShadow({ mode: "open" });
    shadow.adoptedStyleSheets = hostSheets();
    shadow.append(...Array.from(element.childNodes));
    return shadow;
  }

  appendChildrenToTop(many: number) {
    const parentIdx = this.stack.length - many - 1;
    // children of a shadow host live in its shadow root. Every other
    // insertion path (insertAfter/Before, replaceWith) takes `parentNode` of
    // an anchor, which is the ShadowRoot itself for nodes inside one.
    const parent = this.ensureShadowRoot(this.stack[parentIdx][0]);
    const items = this.stack.splice(parentIdx + 1, many);
    this.applyChunk(items, parent, null);
  }

  replaceTopWith(many: number) {
    const targetIdx = this.stack.length - many - 1;
    const target = this.stack[targetIdx][0];
    const items = this.stack.splice(targetIdx + 1, many);
    this.stack.pop();
    const real = target as ListenerElement;
    if (real.listening) this.removeAllNonBubblingListeners(real);
    const parent = target.parentNode as Node;
    const next = target.nextSibling;
    (target as ChildNode).remove();
    this.applyChunk(items, parent, next);
  }

  insertAfterTop(many: number) {
    const anchorIdx = this.stack.length - many - 1;
    const anchor = this.stack[anchorIdx][0];
    const items = this.stack.splice(anchorIdx + 1, many);
    this.applyChunk(items, anchor.parentNode as Node, anchor.nextSibling);
  }

  insertBeforeTop(many: number) {
    const anchorIdx = this.stack.length - many - 1;
    const anchor = this.stack[anchorIdx][0];
    const items = this.stack.splice(anchorIdx + 1, many);
    this.applyChunk(items, anchor.parentNode as Node, anchor);
  }

  setTextTop(text: string) {
    this.stack[this.stack.length - 1][0].textContent = text;
  }

  removeTop() {
    const targetEntry = this.stack.pop();
    if (!targetEntry) return;
    const node = targetEntry[0] as ListenerElement;
    if (node.listening) this.removeAllNonBubblingListeners(node);
    (node as ChildNode).remove();
  }

  setTopAttribute(field: string, value: string, ns: string | null) {
    this.setAttributeInner(
      this.stack[this.stack.length - 1][0],
      field,
      value,
      ns,
    );
  }

  removeTopAttribute(field: string, ns: string | null) {
    const node = this.stack[this.stack.length - 1][0] as any;
    if (!ns) {
      switch (field) {
        case "value":
          node.value = "";
          node.removeAttribute("value");
          break;
        case "checked":
          node.checked = false;
          break;
        case "selected":
          node.selected = false;
          break;
        case "dangerous_inner_html":
          node.innerHTML = "";
          break;
        default:
          node.removeAttribute(field);
          break;
      }
    } else if (ns == "style") {
      node.style.removeProperty(field);
    } else {
      node.removeAttributeNS(ns, field);
    }
  }

  addTopEventListener(event_name: string, bubbles: boolean) {
    const node = this.stack[this.stack.length - 1][0] as ListenerElement;
    const id = this.currentTopId();
    if (node.listening) node.listening += 1;
    else node.listening = 1;
    node.setAttribute("data-dioxus-id", `${id}`);
    this.createListener(event_name, node, bubbles);
  }

  addTopForeignEventListener(event_name: string, bubbles: boolean) {
    const node = this.stack[this.stack.length - 1][0] as ListenerElement;
    const id = this.currentTopId();
    if (node.listening) node.listening += 1;
    else node.listening = 1;
    node.setAttribute("data-dioxus-id", `${id}`);

    if (event_name === "mounted") {
      (window as any).ipc.postMessage(
        this.sendSerializedEvent({
          name: event_name,
          element: id,
          data: null,
          bubbles,
        }),
      );
    } else {
      this.createListener(event_name, node, bubbles);
    }
  }

  removeTopEventListener(event_name: string, bubbles: boolean) {
    const node = this.stack[this.stack.length - 1][0] as ListenerElement;
    node.listening = (node.listening ?? 1) - 1;
    this.removeListener(node, event_name, bubbles);
    if (node.listening <= 0) {
      node.removeAttribute("data-dioxus-id");
    }
  }

  // Insert each node in `items` into `parent` before `cursorBefore`, appending
  // when `cursorBefore` is null. Insertion order is preserved.
  applyChunk(items: StackEntry[], parent: Node, cursorBefore: Node | null) {
    for (const [node] of items) {
      parent.insertBefore(node, cursorBefore);
    }
  }

  setAttributeInner(
    node: Node,
    field: string,
    value: string,
    ns: string | null,
  ) {
    setAttributeInner(node as HTMLElement, field, value, ns ?? "");
    if (field === SHADOW_ATTRIBUTE && !ns) this.ensureShadowRoot(node);
    // Listeners and attributes of one element arrive in no fixed order: a proxy mark that comes
    // after its listeners moves them from the element's own scroll and size to the viewport's.
    if (
      field === SCROLL_PROXY_ATTRIBUTE &&
      !ns &&
      (node as ListenerElement).listening
    ) {
      this.registerScrollProxy(node as Element);
      this.resizeObserver?.unobserve(node as Element);
    }
  }
}
