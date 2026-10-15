// Ripasso dilazionato: STESSO algoritmo del PC (backend/tutor.py), così i due restano allineati.
// voto: 0 = non sapevo, 1 = difficile, 2 = sapevo, 3 = facile.
export const DAY = 86400;

export function review(card, grade, now = Date.now() / 1000) {
  let { ease = 2.5, interval = 0, reps = 0, lapses = 0 } = card;
  if (grade === 0) {
    lapses += 1;
    interval = 10 / 1440;                 // torna fra 10 minuti
    ease = Math.max(1.3, ease - 0.2);
  } else {
    ease = Math.max(1.3, ease + [-0.15, 0, 0.1][grade - 1]);
    if (reps === 0 || interval < 1) interval = [1, 1, 3][grade - 1];
    else interval = interval * (grade === 1 ? 1.2 : ease * (grade === 3 ? 1.3 : 1));
  }
  reps += 1;
  return { ...card, ease, interval, reps, lapses, due: now + interval * DAY, last: now, last_ok: grade > 0 ? 1 : 0 };
}

export const isDue = (c, now = Date.now() / 1000) => c.reps > 0 && c.due <= now;
export const isNew = c => !c.reps;

export function whenLabel(days) {
  if (days < 1 / 24) return 'fra pochi minuti';
  if (days < 1) return `fra ${Math.round(days * 24)} ore`;
  if (days < 1.5) return 'domani';
  if (days < 30) return `fra ${Math.round(days)} giorni`;
  return `fra ${Math.round(days / 30)} mesi`;
}
