/**
 * Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// If the loader is already loaded, just stop.
if (!self.define) {
  let registry = {};

  // Used for `eval` and `importScripts` where we can't get script URL by other means.
  // In both cases, it's safe to use a global var because those functions are synchronous.
  let nextDefineUri;

  const singleRequire = (uri, parentUri) => {
    uri = new URL(uri + ".js", parentUri).href;
    return registry[uri] || (
      
        new Promise(resolve => {
          if ("document" in self) {
            const script = document.createElement("script");
            script.src = uri;
            script.onload = resolve;
            document.head.appendChild(script);
          } else {
            nextDefineUri = uri;
            importScripts(uri);
            resolve();
          }
        })
      
      .then(() => {
        let promise = registry[uri];
        if (!promise) {
          throw new Error(`Module ${uri} didn’t register its module`);
        }
        return promise;
      })
    );
  };

  self.define = (depsNames, factory) => {
    const uri = nextDefineUri || ("document" in self ? document.currentScript.src : "") || location.href;
    if (registry[uri]) {
      // Module is already loading or loaded.
      return;
    }
    let exports = {};
    const require = depUri => singleRequire(depUri, uri);
    const specialDeps = {
      module: { uri },
      exports,
      require
    };
    registry[uri] = Promise.all(depsNames.map(
      depName => specialDeps[depName] || require(depName)
    )).then(deps => {
      factory(...deps);
      return exports;
    });
  };
}
define(['./workbox-afac4cd2'], (function (workbox) { 'use strict';

  self.skipWaiting();
  workbox.clientsClaim();
  /**
   * The precacheAndRoute() method efficiently caches and responds to
   * requests for URLs in the manifest.
   * See https://goo.gl/S9QRab
   */
  workbox.precacheAndRoute([{
    "url": "pwa-maskable-512x512.png",
    "revision": "bc4facb822ddd2ce4670e6db8095c401"
  }, {
    "url": "pwa-512x512.png",
    "revision": "4ae82ccd2563f98f6c0d3de1b68948ad"
  }, {
    "url": "pwa-192x192.png",
    "revision": "1c21ca5b0464b9a4330d367db4aae110"
  }, {
    "url": "pitstop-hero-3333.webp",
    "revision": "9321288020f1cbbd3c51f7a6f43cf87f"
  }, {
    "url": "pitstop-flag-streak.webp",
    "revision": "15cf90a42cc14a0d15d28ada3c1857dc"
  }, {
    "url": "index.html",
    "revision": "d8b5482d1815a68e51439e8610d07407"
  }, {
    "url": "icon.svg",
    "revision": "5b3335d37e3107ede2b06375c94bc37e"
  }, {
    "url": "icon-maskable.svg",
    "revision": "fd91d790e2a75ab2cd0d40723631b037"
  }, {
    "url": "favicon.svg",
    "revision": "989a26d5ef5e1ad8087e2174e7313891"
  }, {
    "url": "apple-touch-icon.png",
    "revision": "4e2aaca7ba4d6a8fa813e853cd7884d2"
  }, {
    "url": "assets/workbox-window.prod.es5-Bd17z0YL.js",
    "revision": null
  }, {
    "url": "assets/web-wZQdQPWL.js",
    "revision": null
  }, {
    "url": "assets/web-EwIPuWDS.js",
    "revision": null
  }, {
    "url": "assets/web-DIEBr1ff.js",
    "revision": null
  }, {
    "url": "assets/index-R7knxmsv.css",
    "revision": null
  }, {
    "url": "assets/index-DAYm5e-x.js",
    "revision": null
  }, {
    "url": "assets/aistudio/rally_escoteiros_merged_66a34567.txt",
    "revision": null
  }, {
    "url": "apple-touch-icon.png",
    "revision": "4e2aaca7ba4d6a8fa813e853cd7884d2"
  }, {
    "url": "icon.svg",
    "revision": "5b3335d37e3107ede2b06375c94bc37e"
  }, {
    "url": "pitstop-flag-streak.webp",
    "revision": "15cf90a42cc14a0d15d28ada3c1857dc"
  }, {
    "url": "pitstop-hero-3333.webp",
    "revision": "9321288020f1cbbd3c51f7a6f43cf87f"
  }, {
    "url": "pwa-192x192.png",
    "revision": "1c21ca5b0464b9a4330d367db4aae110"
  }, {
    "url": "pwa-512x512.png",
    "revision": "4ae82ccd2563f98f6c0d3de1b68948ad"
  }, {
    "url": "pwa-maskable-512x512.png",
    "revision": "bc4facb822ddd2ce4670e6db8095c401"
  }, {
    "url": "manifest.webmanifest",
    "revision": "ae7f6be525972f71d1042d24cc6b1859"
  }], {});
  workbox.cleanupOutdatedCaches();
  workbox.registerRoute(new workbox.NavigationRoute(workbox.createHandlerBoundToURL("index.html")));
  workbox.registerRoute(/^https:\/\/fonts\.googleapis\.com\/.*/i, new workbox.CacheFirst({
    "cacheName": "google-fonts-cache",
    plugins: [new workbox.ExpirationPlugin({
      maxEntries: 10,
      maxAgeSeconds: 31536000
    }), new workbox.CacheableResponsePlugin({
      statuses: [0, 200]
    })]
  }), 'GET');
  workbox.registerRoute(/^https:\/\/fonts\.gstatic\.com\/.*/i, new workbox.CacheFirst({
    "cacheName": "gstatic-fonts-cache",
    plugins: [new workbox.ExpirationPlugin({
      maxEntries: 10,
      maxAgeSeconds: 31536000
    }), new workbox.CacheableResponsePlugin({
      statuses: [0, 200]
    })]
  }), 'GET');

}));
