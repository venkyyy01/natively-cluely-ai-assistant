let transformersPromise = null;

exports.loadTransformers = function loadTransformers() {
  if (!transformersPromise) {
    transformersPromise = Promise.resolve().then(() => require('@xenova/transformers')).catch((error) => {
      transformersPromise = null;
      throw error;
    });
  }

  return transformersPromise;
};
