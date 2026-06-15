'use strict';

window.SlideshowService = (function () {
  const EFFECTS = ['fade', 'slide', 'zoom', 'blur', 'kenburns'];

  function pickEffect(requested) {
    const effect = requested || 'fade';
    if (effect === 'random') {
      return EFFECTS[Math.floor(Math.random() * EFFECTS.length)];
    }
    return effect;
  }

  function getEffectDuration(effect) {
    if (effect === 'none') return 0;
    if (effect === 'kenburns') return 1000;
    if (effect === 'blur') return 800;
    return 700;
  }

  function applyTransition({
    container,
    incoming,
    outgoing,
    src,
    effectName,
    onComplete,
  }) {
    if (!incoming || !outgoing || !container) return;

    if (effectName === 'none') {
      incoming.src = src;
      incoming.classList.add('active');
      outgoing.classList.remove('active');
      if (onComplete) onComplete();
      return;
    }

    container.className = '';
    incoming.className = 'slide-img';
    outgoing.className = 'slide-img active';
    incoming.src = src;

    requestAnimationFrame(() => {
      container.classList.add(`fx-${effectName}`);
      incoming.classList.add('active', 'slide-in');
      outgoing.classList.add('slide-out');

      const duration = getEffectDuration(effectName);
      setTimeout(() => {
        outgoing.classList.remove('active', 'slide-out');
        incoming.classList.remove('slide-in');
        container.className = effectName === 'kenburns' ? 'fx-kenburns' : '';
        if (onComplete) onComplete();
      }, duration);
    });
  }

  function applyClockTransition({
    img,
    src,
    effectName,
    onApplied,
  }) {
    if (!img) return;
    const effect = pickEffect(effectName);

    if (effect === 'none') {
      img.src = src;
      img.style.opacity = '1';
      if (onApplied) onApplied();
      return;
    }

    img.classList.remove('clock-fx-fade', 'clock-fx-slide', 'clock-fx-zoom', 'clock-fx-blur', 'clock-fx-kenburns');
    img.classList.add(`clock-fx-${effect}`);
    img.src = src;
    img.style.opacity = '1';

    const duration = getEffectDuration(effect);
    setTimeout(() => {
      img.classList.remove(`clock-fx-${effect}`);
      if (onApplied) onApplied();
    }, duration);

    if (onApplied && effect === 'none') onApplied();
  }

  return {
    EFFECTS,
    pickEffect,
    getEffectDuration,
    applyTransition,
    applyClockTransition,
  };
})();
