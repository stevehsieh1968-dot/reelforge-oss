// 單機任務佇列：同時最多 RENDER_CONCURRENCY 支影片在合成，其餘排隊
const limit = Number(process.env.RENDER_CONCURRENCY || 2);
let running = 0;
const waiting = [];

export function enqueue(task) {
  return new Promise((resolve, reject) => {
    waiting.push({ task, resolve, reject });
    pump();
  });
}

export function queueLength() {
  return waiting.length;
}

function pump() {
  while (running < limit && waiting.length) {
    const { task, resolve, reject } = waiting.shift();
    running++;
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        running--;
        pump();
      });
  }
}
