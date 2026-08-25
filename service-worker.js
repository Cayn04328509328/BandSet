const CACHE = 'bandset-v5';

const CORE = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',

  './icon-192.png',
  './icon-512.png',
  './apple-touch-icon.png',
  './favicon-32.png'
];

self.addEventListener(
  'install',
  event => {
    event.waitUntil(
      precacheBandSet()
    );

    self.skipWaiting();
  }
);

self.addEventListener(
  'activate',
  event => {
    event.waitUntil(
      caches.keys().then(keys =>
        Promise.all(
          keys
            .filter(
              key => key !== CACHE
            )
            .map(
              key => caches.delete(key)
            )
        )
      )
    );

    self.clients.claim();
  }
);

self.addEventListener(
  'fetch',
  event => {
    if (
      event.request.method !== 'GET'
    ) return;

    const url =
      new URL(event.request.url);

    if (
      url.origin !== self.location.origin
    ) return;

    const shouldUseNetworkFirst =
      event.request.mode === 'navigate' ||
      url.pathname.endsWith('/app.js') ||
      url.pathname.endsWith('/style.css') ||
      url.pathname.includes('/songs/');

    if (shouldUseNetworkFirst) {
      event.respondWith(
        networkFirst(event.request)
      );
    } else {
      event.respondWith(
        cacheFirst(event.request)
      );
    }
  }
);

async function precacheBandSet() {
  const cache =
    await caches.open(CACHE);

  /*
   * Eerst de app zelf.
   */
  await cache.addAll(CORE);

  /*
   * Daarna index.json lezen en alle songs
   * meteen offline beschikbaar maken.
   */
  try {
    const indexResponse = await fetch(
      './songs/index.json',
      {
        cache: 'no-store'
      }
    );

    if (!indexResponse.ok) {
      throw new Error(
        `index.json: ${indexResponse.status}`
      );
    }

    const index =
      await indexResponse.clone().json();

    await cache.put(
      './songs/index.json',
      indexResponse
    );

    await Promise.all(
      (index.files || []).map(
        async file => {
          try {
            const url =
              `./songs/${file}`;

            const response =
              await fetch(
                url,
                {
                  cache: 'no-store'
                }
              );

            if (response.ok) {
              await cache.put(
                url,
                response
              );
            }

          } catch (error) {
            console.warn(
              `Kon ${file} niet vooraf cachen.`,
              error
            );
          }
        }
      )
    );

  } catch (error) {
    console.warn(
      'Songs konden niet vooraf worden gecachet.',
      error
    );
  }
}

async function networkFirst(request) {
  const cache =
    await caches.open(CACHE);

  try {
    const response =
      await fetch(request);

    if (response.ok) {
      cache.put(
        request,
        response.clone()
      );
    }

    return response;

  } catch (error) {
    const cached =
      await cache.match(request);

    if (cached) {
      return cached;
    }

    if (
      request.mode === 'navigate'
    ) {
      return cache.match(
        './index.html'
      );
    }

    throw error;
  }
}

async function cacheFirst(request) {
  const cache =
    await caches.open(CACHE);

  const cached =
    await cache.match(request);

  if (cached) {
    return cached;
  }

  const response =
    await fetch(request);

  if (response.ok) {
    cache.put(
      request,
      response.clone()
    );
  }

  return response;
}
