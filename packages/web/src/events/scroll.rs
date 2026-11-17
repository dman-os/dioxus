use dioxus_html::HasScrollData;
use wasm_bindgen::JsCast;
use web_sys::{Document, Element, Event};

use super::{Synthetic, WebEventExt, mounted::scroller_of};

impl Synthetic<Event> {
    /// The element whose scroll the event reports: the target (or, for the document, its root
    /// element), looking through a scroll proxy to the document's scroller.
    fn scroller(&self) -> Option<Element> {
        let target = self.event.target()?;
        if let Some(element) = target.dyn_ref::<Element>() {
            Some(scroller_of(element))
        } else {
            target.dyn_ref::<Document>()?.document_element()
        }
    }
}

impl HasScrollData for Synthetic<Event> {
    fn as_any(&self) -> &dyn std::any::Any {
        &self.event
    }

    fn scroll_top(&self) -> f64 {
        self.scroller()
            .map_or(0.0, |element| element.scroll_top() as f64)
    }

    fn scroll_left(&self) -> f64 {
        self.scroller()
            .map_or(0.0, |element| element.scroll_left() as f64)
    }

    fn scroll_width(&self) -> i32 {
        self.scroller().map_or(0, |element| element.scroll_width())
    }

    fn scroll_height(&self) -> i32 {
        self.scroller().map_or(0, |element| element.scroll_height())
    }

    fn client_width(&self) -> i32 {
        self.scroller().map_or(0, |element| element.client_width())
    }

    fn client_height(&self) -> i32 {
        self.scroller().map_or(0, |element| element.client_height())
    }
}

impl WebEventExt for dioxus_html::ScrollData {
    type WebEvent = web_sys::Event;

    #[inline(always)]
    fn try_as_web_event(&self) -> Option<Self::WebEvent> {
        self.downcast::<web_sys::Event>().cloned()
    }
}
