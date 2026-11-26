//! Where server functions and renders that hold !Send state (a VirtualDom) run.
//!
//! Native targets pin them to the OS threads of a [`tokio_util::task::LocalPoolHandle`]. A wasm32
//! server (a wasi component) has one thread and cannot start others, so there the embedder says how
//! a !Send future is run to completion with [`set_local_spawner`] and the "pool" is that spawner.

#[cfg(not(target_arch = "wasm32"))]
pub(crate) use tokio::task::JoinHandle;
#[cfg(not(target_arch = "wasm32"))]
pub(crate) use tokio_util::task::LocalPoolHandle;

#[cfg(target_arch = "wasm32")]
pub use wasm::*;

#[cfg(target_arch = "wasm32")]
mod wasm {
    use futures_util::future::{AbortHandle, Abortable, LocalBoxFuture};
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::OnceLock;
    use std::task::{Context, Poll};

    static SPAWNER: OnceLock<fn(LocalBoxFuture<'static, ()>)> = OnceLock::new();

    /// Register how this embedder runs a !Send future to completion on its one thread, for example
    /// `wit_bindgen::spawn_local`. The first registration wins; later calls are ignored so a handler
    /// can register on every request.
    pub fn set_local_spawner(spawner: fn(LocalBoxFuture<'static, ()>)) {
        let _ = SPAWNER.set(spawner);
    }

    /// The wasm32 stand-in for [`tokio_util::task::LocalPoolHandle`]: spawns on the registered spawner.
    #[derive(Clone)]
    pub struct LocalPoolHandle;

    impl LocalPoolHandle {
        pub fn new(_pool_size: usize) -> Self {
            Self
        }

        pub fn spawn_pinned<F, Fut>(&self, create_task: F) -> JoinHandle<Fut::Output>
        where
            F: FnOnce() -> Fut + Send + 'static,
            Fut: Future + 'static,
            Fut::Output: Send + 'static,
        {
            let spawner = SPAWNER
                .get()
                .expect("a wasm32 server needs dioxus_server::set_local_spawner before it serves");
            let (result_tx, result_rx) = futures_channel::oneshot::channel();
            let (abort, registration) = AbortHandle::new_pair();
            spawner(Box::pin(async move {
                // A closed receiver means the handle was dropped; nobody wants the result.
                if let Ok(output) = Abortable::new(create_task(), registration).await {
                    let _ = result_tx.send(output);
                }
            }));
            JoinHandle { result_rx, abort }
        }
    }

    /// The task was aborted before it produced a result.
    #[derive(Debug)]
    pub struct JoinError;

    impl std::fmt::Display for JoinError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str("task was aborted")
        }
    }

    impl std::error::Error for JoinError {}

    pub struct JoinHandle<T> {
        result_rx: futures_channel::oneshot::Receiver<T>,
        abort: AbortHandle,
    }

    impl<T> JoinHandle<T> {
        pub fn abort(&self) {
            self.abort.abort();
        }
    }

    impl<T> Future for JoinHandle<T> {
        type Output = Result<T, JoinError>;

        fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
            Pin::new(&mut self.result_rx)
                .poll(cx)
                .map_err(|_| JoinError)
        }
    }
}
