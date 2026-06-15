/* global Capacitor */
'use strict';

(function registerPhotoLibraryPlugin() {
  if (typeof Capacitor === 'undefined' || typeof Capacitor.registerPlugin !== 'function') {
    return;
  }

  const PhotoLibrary = Capacitor.registerPlugin('PhotoLibrary');
  Capacitor.Plugins = Capacitor.Plugins || {};
  Capacitor.Plugins.PhotoLibrary = PhotoLibrary;
  window.PhotoLibrary = PhotoLibrary;
})();
