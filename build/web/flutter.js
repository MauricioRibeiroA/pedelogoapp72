<<<<<<< HEAD
// Copyright 2014 The Flutter Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

if (!_flutter) {
  var _flutter = {};
}
_flutter.loader = null;

(function () {
  "use strict";

  const baseUri = ensureTrailingSlash(getBaseURI());

  function getBaseURI() {
    const base = document.querySelector("base");
    return (base && base.getAttribute("href")) || "";
  }

  function ensureTrailingSlash(uri) {
    if (uri == "") {
      return uri;
    }
    return uri.endsWith("/") ? uri : `${uri}/`;
  }

  /**
   * Wraps `promise` in a timeout of the given `duration` in ms.
   *
   * Resolves/rejects with whatever the original `promises` does, or rejects
   * if `promise` takes longer to complete than `duration`. In that case,
   * `debugName` is used to compose a legible error message.
   *
   * If `duration` is < 0, the original `promise` is returned unchanged.
   * @param {Promise} promise
   * @param {number} duration
   * @param {string} debugName
   * @returns {Promise} a wrapped promise.
   */
  async function timeout(promise, duration, debugName) {
    if (duration < 0) {
      return promise;
    }
    let timeoutId;
    const _clock = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(
          new Error(
            `${debugName} took more than ${duration}ms to resolve. Moving on.`,
            {
              cause: timeout,
            }
          )
        );
      }, duration);
    });

    return Promise.race([promise, _clock]).finally(() => {
      clearTimeout(timeoutId);
    });
  }

  /**
   * Handles the creation of a TrustedTypes `policy` that validates URLs based
   * on an (optional) incoming array of RegExes.
   */
  class FlutterTrustedTypesPolicy {
    /**
     * Constructs the policy.
     * @param {[RegExp]} validPatterns the patterns to test URLs
     * @param {String} policyName the policy name (optional)
     */
    constructor(validPatterns, policyName = "flutter-js") {
      const patterns = validPatterns || [
        /\.js$/,
      ];
      if (window.trustedTypes) {
        this.policy = trustedTypes.createPolicy(policyName, {
          createScriptURL: function(url) {
            const parsed = new URL(url, window.location);
            const file = parsed.pathname.split("/").pop();
            const matches = patterns.some((pattern) => pattern.test(file));
            if (matches) {
              return parsed.toString();
            }
            console.error(
              "URL rejected by TrustedTypes policy",
              policyName, ":", url, "(download prevented)");
          }
        });
      }
    }
  }

  /**
   * Handles loading/reloading Flutter's service worker, if configured.
   *
   * @see: https://developers.google.com/web/fundamentals/primers/service-workers
   */
  class FlutterServiceWorkerLoader {
    /**
     * Injects a TrustedTypesPolicy (or undefined if the feature is not supported).
     * @param {TrustedTypesPolicy | undefined} policy
     */
    setTrustedTypesPolicy(policy) {
      this._ttPolicy = policy;
    }

    /**
     * Returns a Promise that resolves when the latest Flutter service worker,
     * configured by `settings` has been loaded and activated.
     *
     * Otherwise, the promise is rejected with an error message.
     * @param {*} settings Service worker settings
     * @returns {Promise} that resolves when the latest serviceWorker is ready.
     */
    loadServiceWorker(settings) {
      if (settings == null) {
        // In the future, settings = null -> uninstall service worker?
        console.debug("Null serviceWorker configuration. Skipping.");
        return Promise.resolve();
      }
      if (!("serviceWorker" in navigator)) {
        let errorMessage = "Service Worker API unavailable.";
        if (!window.isSecureContext) {
          errorMessage += "\nThe current context is NOT secure."
          errorMessage += "\nRead more: https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts";
        }
        return Promise.reject(
          new Error(errorMessage)
        );
      }
      const {
        serviceWorkerVersion,
        serviceWorkerUrl = `${baseUri}flutter_service_worker.js?v=${serviceWorkerVersion}`,
        timeoutMillis = 4000,
      } = settings;

      // Apply the TrustedTypes policy, if present.
      let url = serviceWorkerUrl;
      if (this._ttPolicy != null) {
        url = this._ttPolicy.createScriptURL(url);
      }

      const serviceWorkerActivation = navigator.serviceWorker
        .register(url)
        .then((serviceWorkerRegistration) => this._getNewServiceWorker(serviceWorkerRegistration, serviceWorkerVersion))
        .then(this._waitForServiceWorkerActivation);

      // Timeout race promise
      return timeout(
        serviceWorkerActivation,
        timeoutMillis,
        "prepareServiceWorker"
      );
    }

    /**
     * Returns the latest service worker for the given `serviceWorkerRegistration`.
     *
     * This might return the current service worker, if there's no new service worker
     * awaiting to be installed/updated.
     *
     * @param {ServiceWorkerRegistration} serviceWorkerRegistration
     * @param {String} serviceWorkerVersion
     * @returns {Promise<ServiceWorker>}
     */
    async _getNewServiceWorker(serviceWorkerRegistration, serviceWorkerVersion) {
      if (!serviceWorkerRegistration.active && (serviceWorkerRegistration.installing || serviceWorkerRegistration.waiting)) {
        // No active web worker and we have installed or are installing
        // one for the first time. Simply wait for it to activate.
        console.debug("Installing/Activating first service worker.");
        return serviceWorkerRegistration.installing || serviceWorkerRegistration.waiting;
      } else if (!serviceWorkerRegistration.active.scriptURL.endsWith(serviceWorkerVersion)) {
        // When the app updates the serviceWorkerVersion changes, so we
        // need to ask the service worker to update.
        const newRegistration = await serviceWorkerRegistration.update();
        console.debug("Updating service worker.");
        return newRegistration.installing || newRegistration.waiting || newRegistration.active;
      } else {
        console.debug("Loading from existing service worker.");
        return serviceWorkerRegistration.active;
      }
    }

    /**
     * Returns a Promise that resolves when the `serviceWorker` changes its
     * state to "activated".
     *
     * @param {ServiceWorker} serviceWorker
     * @returns {Promise<void>}
     */
    async _waitForServiceWorkerActivation(serviceWorker) {
      if (!serviceWorker || serviceWorker.state == "activated") {
        if (!serviceWorker) {
          throw new Error("Cannot activate a null service worker!");
        } else {
          console.debug("Service worker already active.");
          return;
        }
      }
      return new Promise((resolve, _) => {
        serviceWorker.addEventListener("statechange", () => {
          if (serviceWorker.state == "activated") {
            console.debug("Activated new service worker.");
            resolve();
          }
        });
      });
    }
  }

  /**
   * Handles injecting the main Flutter web entrypoint (main.dart.js), and notifying
   * the user when Flutter is ready, through `didCreateEngineInitializer`.
   *
   * @see https://docs.flutter.dev/development/platform-integration/web/initialization
   */
  class FlutterEntrypointLoader {
    /**
     * Creates a FlutterEntrypointLoader.
     */
    constructor() {
      // Watchdog to prevent injecting the main entrypoint multiple times.
      this._scriptLoaded = false;
    }

    /**
     * Injects a TrustedTypesPolicy (or undefined if the feature is not supported).
     * @param {TrustedTypesPolicy | undefined} policy
     */
    setTrustedTypesPolicy(policy) {
      this._ttPolicy = policy;
    }

    /**
     * Loads flutter main entrypoint, specified by `entrypointUrl`, and calls a
     * user-specified `onEntrypointLoaded` callback with an EngineInitializer
     * object when it's done.
     *
     * @param {*} options
     * @returns {Promise | undefined} that will eventually resolve with an
     * EngineInitializer, or will be rejected with the error caused by the loader.
     * Returns undefined when an `onEntrypointLoaded` callback is supplied in `options`.
     */
    async loadEntrypoint(options) {
      const { entrypointUrl = `${baseUri}main.dart.js`, onEntrypointLoaded } =
        options || {};

      return this._loadEntrypoint(entrypointUrl, onEntrypointLoaded);
    }

    /**
     * Resolves the promise created by loadEntrypoint, and calls the `onEntrypointLoaded`
     * function supplied by the user (if needed).
     *
     * Called by Flutter through `_flutter.loader.didCreateEngineInitializer` method,
     * which is bound to the correct instance of the FlutterEntrypointLoader by
     * the FlutterLoader object.
     *
     * @param {Function} engineInitializer @see https://github.com/flutter/engine/blob/main/lib/web_ui/lib/src/engine/js_interop/js_loader.dart#L42
     */
    didCreateEngineInitializer(engineInitializer) {
      if (typeof this._didCreateEngineInitializerResolve === "function") {
        this._didCreateEngineInitializerResolve(engineInitializer);
        // Remove the resolver after the first time, so Flutter Web can hot restart.
        this._didCreateEngineInitializerResolve = null;
        // Make the engine revert to "auto" initialization on hot restart.
        delete _flutter.loader.didCreateEngineInitializer;
      }
      if (typeof this._onEntrypointLoaded === "function") {
        this._onEntrypointLoaded(engineInitializer);
      }
    }

    /**
     * Injects a script tag into the DOM, and configures this loader to be able to
     * handle the "entrypoint loaded" notifications received from Flutter web.
     *
     * @param {string} entrypointUrl the URL of the script that will initialize
     *                 Flutter.
     * @param {Function} onEntrypointLoaded a callback that will be called when
     *                   Flutter web notifies this object that the entrypoint is
     *                   loaded.
     * @returns {Promise | undefined} a Promise that resolves when the entrypoint
     *                                is loaded, or undefined if `onEntrypointLoaded`
     *                                is a function.
     */
    _loadEntrypoint(entrypointUrl, onEntrypointLoaded) {
      const useCallback = typeof onEntrypointLoaded === "function";

      if (!this._scriptLoaded) {
        this._scriptLoaded = true;
        const scriptTag = this._createScriptTag(entrypointUrl);
        if (useCallback) {
          // Just inject the script tag, and return nothing; Flutter will call
          // `didCreateEngineInitializer` when it's done.
          console.debug("Injecting <script> tag. Using callback.");
          this._onEntrypointLoaded = onEntrypointLoaded;
          document.body.append(scriptTag);
        } else {
          // Inject the script tag and return a promise that will get resolved
          // with the EngineInitializer object from Flutter when it calls
          // `didCreateEngineInitializer` later.
          return new Promise((resolve, reject) => {
            console.debug(
              "Injecting <script> tag. Using Promises. Use the callback approach instead!"
            );
            this._didCreateEngineInitializerResolve = resolve;
            scriptTag.addEventListener("error", reject);
            document.body.append(scriptTag);
          });
        }
      }
    }

    /**
     * Creates a script tag for the given URL.
     * @param {string} url
     * @returns {HTMLScriptElement}
     */
    _createScriptTag(url) {
      const scriptTag = document.createElement("script");
      scriptTag.type = "application/javascript";
      // Apply TrustedTypes validation, if available.
      let trustedUrl = url;
      if (this._ttPolicy != null) {
        trustedUrl = this._ttPolicy.createScriptURL(url);
      }
      scriptTag.src = trustedUrl;
      return scriptTag;
    }
  }

  /**
   * The public interface of _flutter.loader. Exposes two methods:
   * * loadEntrypoint (which coordinates the default Flutter web loading procedure)
   * * didCreateEngineInitializer (which is called by Flutter to notify that its
   *                              Engine is ready to be initialized)
   */
  class FlutterLoader {
    /**
     * Initializes the Flutter web app.
     * @param {*} options
     * @returns {Promise?} a (Deprecated) Promise that will eventually resolve
     *                     with an EngineInitializer, or will be rejected with
     *                     any error caused by the loader. Or Null, if the user
     *                     supplies an `onEntrypointLoaded` Function as an option.
     */
    async loadEntrypoint(options) {
      const { serviceWorker, ...entrypoint } = options || {};

      // A Trusted Types policy that is going to be used by the loader.
      const flutterTT = new FlutterTrustedTypesPolicy();

      // The FlutterServiceWorkerLoader instance could be injected as a dependency
      // (and dynamically imported from a module if not present).
      const serviceWorkerLoader = new FlutterServiceWorkerLoader();
      serviceWorkerLoader.setTrustedTypesPolicy(flutterTT.policy);
      await serviceWorkerLoader.loadServiceWorker(serviceWorker).catch(e => {
        // Regardless of what happens with the injection of the SW, the show must go on
        console.warn("Exception while loading service worker:", e);
      });

      // The FlutterEntrypointLoader instance could be injected as a dependency
      // (and dynamically imported from a module if not present).
      const entrypointLoader = new FlutterEntrypointLoader();
      entrypointLoader.setTrustedTypesPolicy(flutterTT.policy);
      // Install the `didCreateEngineInitializer` listener where Flutter web expects it to be.
      this.didCreateEngineInitializer =
        entrypointLoader.didCreateEngineInitializer.bind(entrypointLoader);
      return entrypointLoader.loadEntrypoint(entrypoint);
    }
  }

  _flutter.loader = new FlutterLoader();
})();
=======
(()=>{var a=window._flutter;a||(a=window._flutter={});a.loader=null;(function(){"use strict";let l=p(u());function u(){let n=document.querySelector("base");return n&&n.getAttribute("href")||""}function p(n){return n==""||n.endsWith("/")?n:`${n}/`}async function d(n,e,r){if(e<0)return n;let t,i=new Promise((o,s)=>{t=setTimeout(()=>{s(new Error(`${r} took more than ${e}ms to resolve. Moving on.`,{cause:d}))},e)});return Promise.race([n,i]).finally(()=>{clearTimeout(t)})}class y{constructor(e,r="flutter-js"){let t=e||[/\.js$/];window.trustedTypes&&(this.policy=trustedTypes.createPolicy(r,{createScriptURL:function(i){let o=new URL(i,window.location),s=o.pathname.split("/").pop();if(t.some(w=>w.test(s)))return o.toString();console.error("URL rejected by TrustedTypes policy",r,":",i,"(download prevented)")}}))}}class g{setTrustedTypesPolicy(e){this._ttPolicy=e}loadServiceWorker(e){if(e==null)return console.debug("Null serviceWorker configuration. Skipping."),Promise.resolve();if(!("serviceWorker"in navigator)){let c="Service Worker API unavailable.";return window.isSecureContext||(c+=`
The current context is NOT secure.`,c+=`
Read more: https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts`),Promise.reject(new Error(c))}let{serviceWorkerVersion:r,serviceWorkerUrl:t=`${l}flutter_service_worker.js?v=${r}`,timeoutMillis:i=4e3}=e,o=t;this._ttPolicy!=null&&(o=this._ttPolicy.createScriptURL(o));let s=navigator.serviceWorker.register(o).then(c=>this._getNewServiceWorker(c,r)).then(this._waitForServiceWorkerActivation);return d(s,i,"prepareServiceWorker")}async _getNewServiceWorker(e,r){if(!e.active&&(e.installing||e.waiting))return console.debug("Installing/Activating first service worker."),e.installing||e.waiting;if(e.active.scriptURL.endsWith(r))return console.debug("Loading from existing service worker."),e.active;{let t=await e.update();return console.debug("Updating service worker."),t.installing||t.waiting||t.active}}async _waitForServiceWorkerActivation(e){if(!e||e.state=="activated")if(e){console.debug("Service worker already active.");return}else throw new Error("Cannot activate a null service worker!");return new Promise((r,t)=>{e.addEventListener("statechange",()=>{e.state=="activated"&&(console.debug("Activated new service worker."),r())})})}}class f{constructor(){this._scriptLoaded=!1}setTrustedTypesPolicy(e){this._ttPolicy=e}async loadEntrypoint(e){let{entrypointUrl:r=`${l}main.dart.js`,onEntrypointLoaded:t,nonce:i}=e||{};return this._loadEntrypoint(r,t,i)}didCreateEngineInitializer(e){typeof this._didCreateEngineInitializerResolve=="function"&&(this._didCreateEngineInitializerResolve(e),this._didCreateEngineInitializerResolve=null,delete a.loader.didCreateEngineInitializer),typeof this._onEntrypointLoaded=="function"&&this._onEntrypointLoaded(e)}_loadEntrypoint(e,r,t){let i=typeof r=="function";if(!this._scriptLoaded){this._scriptLoaded=!0;let o=this._createScriptTag(e,t);if(i)console.debug("Injecting <script> tag. Using callback."),this._onEntrypointLoaded=r,document.body.append(o);else return new Promise((s,c)=>{console.debug("Injecting <script> tag. Using Promises. Use the callback approach instead!"),this._didCreateEngineInitializerResolve=s,o.addEventListener("error",c),document.body.append(o)})}}_createScriptTag(e,r){let t=document.createElement("script");t.type="application/javascript",r&&(t.nonce=r);let i=e;return this._ttPolicy!=null&&(i=this._ttPolicy.createScriptURL(e)),t.src=i,t}}class v{async loadEntrypoint(e){let{serviceWorker:r,...t}=e||{},i=new y,o=new g;o.setTrustedTypesPolicy(i.policy),await o.loadServiceWorker(r).catch(c=>{console.warn("Exception while loading service worker:",c)});let s=new f;return s.setTrustedTypesPolicy(i.policy),this.didCreateEngineInitializer=s.didCreateEngineInitializer.bind(s),s.loadEntrypoint(t)}}a.loader=new v})();})();
//# sourceMappingURL=flutter.js.map
>>>>>>> 7935231dfdee51578a462bb9f381bfae438da98d
