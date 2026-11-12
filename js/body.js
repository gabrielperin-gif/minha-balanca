/*
 * Cálculos de composição corporal a partir de peso + impedância.
 *
 * O algoritmo do app OKOK é fechado, então usamos equações publicadas:
 *  - Massa livre de gordura: Sun et al., 2003 (Am J Clin Nutr 77:331)
 *  - Massa muscular esquelética: Janssen et al., 2000 (J Appl Physiol 89:465)
 *  - Taxa metabólica basal: Katch-McArdle (com massa magra) ou Mifflin-St Jeor
 *  - Sem impedância: % de gordura estimado pelo IMC (Deurenberg, 1991)
 *
 * São ESTIMATIVAS. Os números podem diferir do app original; use a
 * "correção de gordura" nas configurações para alinhar, se quiser.
 */
(function (global) {
  'use strict';

  function ageAt(birthISO, when) {
    if (!birthISO) return null;
    const b = new Date(birthISO + 'T00:00:00');
    const d = new Date(when);
    let a = d.getFullYear() - b.getFullYear();
    const m = d.getMonth() - b.getMonth();
    if (m < 0 || (m === 0 && d.getDate() < b.getDate())) a--;
    return a;
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function bmiClass(bmi) {
    if (bmi < 18.5) return { label: 'Abaixo do peso', level: 'warn' };
    if (bmi < 25) return { label: 'Normal', level: 'ok' };
    if (bmi < 30) return { label: 'Sobrepeso', level: 'warn' };
    return { label: 'Obesidade', level: 'bad' };
  }

  // Faixas aproximadas (Gallagher et al., 2000), ajustadas pela idade.
  function fatClass(fat, male, age) {
    const older = age >= 40 ? (age >= 60 ? 2 : 1) : 0;
    const t = male
      ? [[8, 20, 25], [11, 22, 28], [13, 25, 30]][older]
      : [[21, 33, 39], [23, 34, 40], [24, 36, 42]][older];
    if (fat < t[0]) return { label: 'Baixo', level: 'warn' };
    if (fat < t[1]) return { label: 'Saudável', level: 'ok' };
    if (fat < t[2]) return { label: 'Alto', level: 'warn' };
    return { label: 'Muito alto', level: 'bad' };
  }

  /**
   * @param {{sex:'M'|'F', birth:string, height:number, fatOffset?:number}} profile
   * @param {{weight:number, impedance:number|null, ts:number}} m
   */
  function compute(profile, m) {
    const w = m.weight;
    const h = Number(profile.height);
    const male = profile.sex === 'M';
    const age = ageAt(profile.birth, m.ts);
    const out = { weight: w, age, impedance: m.impedance || null };
    if (!h || age == null) return out; // perfil incompleto: só o peso

    const hm = h / 100;
    out.bmi = w / (hm * hm);
    out.bmiClass = bmiClass(out.bmi);

    const offset = Number(profile.fatOffset) || 0;
    const imp = m.impedance;
    let ffm;

    if (imp && imp > 100 && imp < 1500) {
      const hr = (h * h) / imp;
      ffm = male
        ? -10.68 + 0.65 * hr + 0.26 * w + 0.02 * imp
        : -9.53 + 0.69 * hr + 0.17 * w + 0.02 * imp;
      ffm = clamp(ffm, w * 0.4, w * 0.97);
      out.fat = clamp(((w - ffm) / w) * 100 + offset, 3, 70);
      ffm = w * (1 - out.fat / 100);
      out.muscle = clamp(0.401 * hr + 3.825 * (male ? 1 : 0) - 0.071 * age + 5.102, 5, ffm);
      out.method = 'bioimpedância';
    } else {
      out.fat = clamp(1.2 * out.bmi + 0.23 * age - 10.8 * (male ? 1 : 0) - 5.4 + offset, 3, 70);
      ffm = w * (1 - out.fat / 100);
      out.method = 'estimado pelo IMC';
    }

    out.fatMass = w - ffm;
    out.leanMass = ffm;
    out.water = ((ffm * 0.732) / w) * 100;
    out.bmr = imp ? 370 + 21.6 * ffm : 10 * w + 6.25 * h - 5 * age + (male ? 5 : -161);
    out.fatClass = fatClass(out.fat, male, age);
    return out;
  }

  global.Body = { compute, ageAt };
})(window);
