/* global Capacitor */
'use strict';

window.MuralPlatform = (function () {
  function getCapacitor() {
    return typeof Capacitor !== 'undefined' ? Capacitor : null;
  }

  function isNativePlatform() {
    const cap = getCapacitor();
    return !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform());
  }

  function getPlatform() {
    const cap = getCapacitor();
    if (!cap || typeof cap.getPlatform !== 'function') return 'web';
    return cap.getPlatform();
  }

  function isNativeIOS() {
    return isNativePlatform() && getPlatform() === 'ios';
  }

  function convertFileSrc(path) {
    const cap = getCapacitor();
    if (cap && typeof cap.convertFileSrc === 'function') {
      return cap.convertFileSrc(path);
    }
    return path;
  }

  function getPhotoLibraryPlugin() {
    const cap = getCapacitor();
    if (!cap || !cap.Plugins || !cap.Plugins.PhotoLibrary) return null;
    return cap.Plugins.PhotoLibrary;
  }

  return {
    getCapacitor,
    isNativePlatform,
    getPlatform,
    isNativeIOS,
    convertFileSrc,
    getPhotoLibraryPlugin,
  };
})();
