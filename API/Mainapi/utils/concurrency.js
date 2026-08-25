/**
 * Concurrency limiter (p-limit style).
 * Extracted from server.js — limits parallel promise execution.
 */

// === LIMITEUR DE CONCURRENCE (p-limit style) ===
// Fonction pour limiter le nombre de promesses exécutées en parallèle
function createConcurrencyLimiter(concurrency) {
  const queue = [];
  let activeCount = 0;

  const next = () => {
    activeCount--;
    if (queue.length > 0) {
      queue.shift()();
    }
  };

  const run = async (fn) => {
    activeCount++;
    try {
      return await fn();
    } finally {
      next();
    }
  };

  const enqueue = (fn) => {
    return new Promise((resolve, reject) => {
      const task = () => run(fn).then(resolve, reject);
      if (activeCount < concurrency) {
        task();
      } else {
        queue.push(task);
      }
    });
  };

  return enqueue;
}

// Limiteurs pré-configurés pour différents cas d'usage
const limitConcurrency5 = createConcurrencyLimiter(5);   // Pour les requêtes réseau légères
const limitConcurrency3 = createConcurrencyLimiter(3);   // Pour les requêtes réseau lourdes
const limitConcurrency10 = createConcurrencyLimiter(10); // Pour les opérations I/O locales

module.exports = {
  createConcurrencyLimiter,
  limitConcurrency5,
  limitConcurrency3,
  limitConcurrency10
};
