/*
 * Composição corporal a partir de peso + impedância (balança de 4 eletrodos,
 * corrente pé-a-pé).
 *
 * O que a balança MEDE: peso e impedância. Todo o resto é ESTIMADO:
 *  - Massa livre de gordura: Sun et al., 2003 (Am J Clin Nutr 77:331)
 *  - Músculo esquelético: Janssen et al., 2000 (J Appl Physiol 89:465)
 *  - Água: hidratação média da massa magra de 73,2% (Wang et al., 1999)
 *  - Osso e proteína: proporções médias da massa magra (Wang, modelo de 5 níveis)
 *  - Metabolismo basal: Katch-McArdle (massa magra) ou Mifflin-St Jeor
 *  - Idade metabólica: idade em que o metabolismo médio (Mifflin) = o seu
 *  - Gordura visceral: índice 1-30 aproximado a partir de gordura, idade, sexo
 *    e, se informada, cintura (relação cintura/altura, Ashwell 2012)
 *  - Sem impedância: % de gordura pelo IMC (Deurenberg, 1991)
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

  /* ---------- Faixas de referência ---------- */

  // Gordura corporal (Gallagher et al., 2000), por sexo e faixa etária.
  function fatBands(male, age) {
    const i = age >= 60 ? 2 : age >= 40 ? 1 : 0;
    const t = male
      ? [[8, 20, 25], [11, 22, 28], [13, 25, 30]][i]
      : [[21, 33, 39], [23, 34, 40], [24, 36, 42]][i];
    return t;
  }

  // Músculo esquelético em % do peso (média ± 1 DP de Janssen 2000).
  const muscleBands = (male) => (male ? [33.3, 43.5] : [25.1, 36.1]);

  // Massa óssea típica por peso (tabela de referência usada em balanças BIA).
  function boneRef(male, w) {
    if (male) return w < 60 ? 2.5 : w < 75 ? 2.9 : 3.2;
    return w < 45 ? 1.8 : w < 60 ? 2.2 : 2.5;
  }

  /* ---------- Avaliação genérica por faixas ---------- */

  // bands: [{to, level, label}], em ordem crescente; o último sem "to".
  function rate(value, bands) {
    for (const b of bands) if (b.to == null || value < b.to) return { level: b.level, label: b.label };
    return null;
  }

  /* ---------- Cálculo principal ---------- */

  /**
   * @param {{sex:'M'|'F', birth:string, height:number, waist?:number, fatOffset?:number}} profile
   * @param {{weight:number, impedance:number|null, ts:number}} m
   */
  function compute(profile, m) {
    const w = m.weight;
    const h = Number(profile.height);
    const male = profile.sex === 'M';
    const age = ageAt(profile.birth, m.ts);
    const out = { weight: w, age, male, impedance: m.impedance || null, complete: false };
    if (!h || age == null || !profile.sex) return out; // perfil incompleto: só o peso
    out.complete = true;

    const hm = h / 100;
    const offset = Number(profile.fatOffset) || 0;
    const imp = m.impedance && m.impedance > 100 && m.impedance < 1500 ? m.impedance : null;
    out.hasImpedance = !!imp;

    out.bmi = w / (hm * hm);

    let ffm;
    if (imp) {
      const hr = (h * h) / imp;
      ffm = male
        ? -10.68 + 0.65 * hr + 0.26 * w + 0.02 * imp
        : -9.53 + 0.69 * hr + 0.17 * w + 0.02 * imp;
      ffm = clamp(ffm, w * 0.4, w * 0.97);
      out.fat = clamp(((w - ffm) / w) * 100 + offset, 3, 70);
      ffm = w * (1 - out.fat / 100);
      out.skeletal = clamp(0.401 * hr + 3.825 * (male ? 1 : 0) - 0.071 * age + 5.102, 5, ffm * 0.7);
    } else {
      out.fat = clamp(1.2 * out.bmi + 0.23 * age - 10.8 * (male ? 1 : 0) - 5.4 + offset, 3, 70);
      ffm = w * (1 - out.fat / 100);
      out.skeletal = ffm * (male ? 0.53 : 0.5);
    }

    out.leanMass = ffm;
    out.fatMass = w - ffm;
    out.skeletalPct = (out.skeletal / w) * 100;
    const tbw = ffm * 0.732;
    out.water = (tbw / w) * 100;
    out.bone = clamp(ffm * 0.052, 1.2, 5);
    out.muscleMass = ffm - out.bone; // "massa muscular" como nas balanças comerciais
    out.protein = clamp(((ffm - tbw - out.bone * 1.2) / w) * 100, 5, 30);

    const mifflin = 10 * w + 6.25 * h - 5 * age + (male ? 5 : -161);
    out.bmr = imp ? 370 + 21.6 * ffm : mifflin;
    // Idade metabólica: compara seu metabolismo (Katch-McArdle) com o de uma
    // pessoa de referência de mesmo sexo, idade e peso, com gordura no limite
    // saudável da faixa etária. Cada ~10 kcal de diferença ≈ 1 ano.
    if (imp) {
      const refFat = fatBands(male, age)[1];
      const refBmr = 370 + 21.6 * w * (1 - refFat / 100);
      out.metabolicAge = Math.round(clamp(age + (refBmr - out.bmr) / 10, Math.max(12, age - 20), Math.min(90, age + 20)));
    }

    // Gordura visceral (índice 1-30). Modelo aproximado, calibrado para a escala
    // usada pelas balanças comerciais (1-9 bom, 10-12 atenção, 13+ alto).
    let vis = male
      ? 1 + 0.45 * Math.max(0, out.fat - 8) + 0.1 * Math.max(0, age - 20)
      : 1 + 0.3 * Math.max(0, out.fat - 18) + 0.08 * Math.max(0, age - 20);
    const waist = Number(profile.waist) || null;
    if (waist) {
      out.whtr = waist / h;
      const visW = male ? (out.whtr - 0.4) * 60 : (out.whtr - 0.42) * 50;
      vis = (vis + Math.max(1, visW)) / 2;
    }
    out.visceral = Math.round(clamp(vis, 1, 30));

    out.idealWeight = 22 * hm * hm;
    out.healthyMin = 18.5 * hm * hm;
    out.healthyMax = 24.9 * hm * hm;

    // Avaliações
    const [f0, f1, f2] = fatBands(male, age);
    out.fatBands = [f0, f1, f2];
    const [m0, m1] = muscleBands(male);
    const bref = boneRef(male, w);
    out.boneRef = bref;

    // Faixas (valores absolutos) — usadas para avaliar e para desenhar as barras.
    const B = {
      bmi: [
        { to: 18.5, level: 'warn', label: 'Abaixo do peso' },
        { to: 25, level: 'ok', label: 'Normal' },
        { to: 30, level: 'warn', label: 'Sobrepeso' },
        { level: 'bad', label: 'Obesidade' },
      ],
      fat: [
        { to: f0, level: 'warn', label: 'Baixo' },
        { to: f1, level: 'ok', label: 'Bom' },
        { to: f2, level: 'warn', label: 'Alto' },
        { level: 'bad', label: 'Muito alto' },
      ],
      visceral: [
        { to: 10, level: 'ok', label: 'Bom' },
        { to: 13, level: 'warn', label: 'Atenção' },
        { level: 'bad', label: 'Alto' },
      ],
      skeletal: [
        { to: m0, level: 'warn', label: 'Baixo' },
        { to: m1, level: 'ok', label: 'Bom' },
        { level: 'ok', label: 'Ótimo' },
      ],
      water: male
        ? [{ to: 50, level: 'warn', label: 'Baixa' }, { to: 65, level: 'ok', label: 'Boa' }, { level: 'ok', label: 'Ótima' }]
        : [{ to: 45, level: 'warn', label: 'Baixa' }, { to: 60, level: 'ok', label: 'Boa' }, { level: 'ok', label: 'Ótima' }],
      protein: [
        { to: 15, level: 'warn', label: 'Baixa' },
        { to: 20, level: 'ok', label: 'Boa' },
        { level: 'ok', label: 'Ótima' },
      ],
      bone: [
        { to: Math.round((bref - 0.2) * 10) / 10, level: 'warn', label: 'Abaixo da média' },
        { level: 'ok', label: 'Normal' },
      ],
      metabolicAge: [
        { to: age - 4, level: 'ok', label: 'Ótima' },
        { to: age + 1, level: 'ok', label: 'Boa' },
        { to: age + 6, level: 'warn', label: 'Regular' },
        { level: 'bad', label: 'Ruim' },
      ],
      whtr: [
        { to: 0.5, level: 'ok', label: 'Boa' },
        { to: 0.6, level: 'warn', label: 'Atenção' },
        { level: 'bad', label: 'Alta' },
      ],
    };
    out.bands = B;
    out.ratings = {
      bmi: rate(out.bmi, B.bmi),
      fat: rate(out.fat, B.fat),
      visceral: rate(out.visceral, B.visceral),
      skeletal: rate(out.skeletalPct, B.skeletal),
      water: rate(out.water, B.water),
      protein: rate(out.protein, B.protein),
      bone: rate(out.bone, B.bone),
    };
    if (out.metabolicAge != null) out.ratings.metabolicAge = rate(out.metabolicAge, B.metabolicAge);
    if (out.whtr) out.ratings.whtr = rate(out.whtr, B.whtr);

    // Tipo corporal (matriz gordura × músculo)
    const fatLvl = out.fat < f0 ? 0 : out.fat < f1 ? 1 : 2;
    const musLvl = out.skeletalPct < m0 ? 0 : out.skeletalPct < m1 ? 1 : 2;
    out.bodyType = [
      ['Magro', 'Magro e musculoso', 'Muito musculoso'],
      ['Pouco exercitado', 'Equilibrado', 'Equilibrado e musculoso'],
      ['Obesidade oculta', 'Acima do peso', 'Robusto'],
    ][fatLvl][musLvl];

    out.score = score(out);
    return out;
  }

  /* ---------- Pontuação 0-100 ---------- */
  const SCORE_WEIGHTS = { fat: 30, visceral: 20, bmi: 15, skeletal: 15, water: 10, protein: 5, metabolicAge: 5 };
  function score(r) {
    let total = 0, max = 0;
    for (const [k, wt] of Object.entries(SCORE_WEIGHTS)) {
      const rt = r.ratings[k];
      if (!rt) continue;
      max += wt;
      total += rt.level === 'ok' ? wt : rt.level === 'warn' ? wt * 0.5 : 0;
    }
    const s = Math.round((total / max) * 100);
    const label = s >= 85 ? 'Ótimo' : s >= 70 ? 'Bom' : s >= 55 ? 'Regular' : 'Ruim';
    const level = s >= 70 ? 'ok' : s >= 55 ? 'warn' : 'bad';
    return { value: s, label, level };
  }

  /* ---------- Análise em texto ---------- */
  const f1n = (n) => n.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  /**
   * @param r      resultado de compute() da medição atual
   * @param past   resultado de compute() de ~30 dias atrás (ou null)
   * @param days   dias entre as duas
   */
  function analyze(r, past, days) {
    const good = [];
    const attention = [];
    const R = r.ratings;

    // Gordura
    const [f0, f1] = r.fatBands;
    if (R.fat.level === 'ok') good.push(`Gordura corporal na faixa saudável (${f1n(r.fat)}%).`);
    else if (r.fat >= f1) {
      const target = (f1 - 1) / 100;
      const targetW = r.leanMass / (1 - target);
      const lose = r.weight - targetW;
      attention.push(`Gordura corporal de ${f1n(r.fat)}%, acima da faixa saudável (até ${f1}%). Perder cerca de ${f1n(lose)} kg de gordura, mantendo os músculos, te colocaria na faixa.`);
    } else {
      attention.push(`Gordura corporal de ${f1n(r.fat)}%, abaixo do recomendado (${f0}%). Um pouco de gordura é essencial para hormônios e energia.`);
    }

    // Visceral
    if (R.visceral.level === 'ok') good.push(`Gordura visceral em nível bom (${r.visceral}).`);
    else attention.push(`Gordura visceral em nível ${r.visceral} (${R.visceral.label.toLowerCase()}). É a gordura em volta dos órgãos, na barriga. Atividade aeróbica regular e menos açúcar e álcool costumam reduzi-la.`);

    // Músculo
    if (R.skeletal.level === 'ok') good.push(`Músculos em bom nível (${f1n(r.skeletalPct)}% do peso).`);
    else attention.push(`Músculo esquelético abaixo da média (${f1n(r.skeletalPct)}% do peso). Treino de força 2 a 3 vezes por semana e proteína suficiente nas refeições ajudam a ganhar massa.`);

    // Água
    if (R.water.level !== 'ok') attention.push(`Água corporal baixa (${f1n(r.water)}%). Pode ser hidratação insuficiente — ou só o horário da pesagem.`);

    // Proteína
    if (R.protein.level !== 'ok') attention.push(`Proteína corporal baixa (${f1n(r.protein)}%), geralmente ligada a pouca massa muscular.`);

    // IMC
    if (R.bmi.level === 'ok') good.push(`IMC normal (${f1n(r.bmi)}).`);
    else if (r.bmi < 18.5) attention.push(`IMC de ${f1n(r.bmi)}, abaixo do peso. Faixa saudável para sua altura: ${f1n(r.healthyMin)} a ${f1n(r.healthyMax)} kg.`);
    else attention.push(`IMC de ${f1n(r.bmi)} (${R.bmi.label.toLowerCase()}). Faixa saudável para sua altura: ${f1n(r.healthyMin)} a ${f1n(r.healthyMax)} kg. Lembre que o IMC não separa músculo de gordura.`);

    // Idade metabólica
    if (R.metabolicAge) {
      const d = r.metabolicAge - r.age;
      if (d <= 0) good.push(`Idade metabólica de ${r.metabolicAge} anos, ${d < 0 ? `${-d} abaixo da` : 'igual à'} sua idade.`);
      else attention.push(`Idade metabólica de ${r.metabolicAge} anos, ${d} acima da sua idade. Ganhar massa muscular é o que mais acelera o metabolismo.`);
    }

    // Cintura
    if (R.whtr && R.whtr.level !== 'ok') attention.push(`A cintura está acima de metade da sua altura (relação ${r.whtr.toFixed(2).replace('.', ',')}), um sinal ligado a risco cardiovascular.`);

    // Tendência
    let trend = null;
    if (past && days >= 5) {
      const dw = r.weight - past.weight;
      const df = r.fatMass - past.fatMass;
      const dl = r.leanMass - past.leanMass;
      const sg = (n) => (n > 0 ? '+' : n < 0 ? '−' : '') + f1n(Math.abs(n));
      let msg = `Em ${days} dias: peso ${sg(dw)} kg, gordura ${sg(df)} kg, massa magra ${sg(dl)} kg.`;
      if (dw < -0.3 && df < 0 && dl >= -0.3) msg += ' Ótimo: o peso perdido veio da gordura.';
      else if (dw < -0.3 && dl < -0.3 && Math.abs(dl) > Math.abs(df)) msg += ' Atenção: boa parte do peso perdido foi massa magra. Mais proteína e treino de força ajudam a preservá-la.';
      else if (dw > 0.3 && dl > 0 && df <= 0.2) msg += ' Bom sinal: você ganhou massa magra sem ganhar gordura.';
      else if (df > 0.3) msg += ' A gordura subiu neste período.';
      else if (Math.abs(dw) <= 0.3) msg += ' Peso estável.';
      trend = msg;
    }

    let summary = `Pontuação ${r.score.value}/100 (${r.score.label.toLowerCase()}). Tipo corporal: ${r.bodyType.toLowerCase()}.`;
    if (!r.hasImpedance) summary += ' Esta pesagem não teve bioimpedância, então os índices foram estimados pelo IMC e são menos precisos.';

    return { summary, good, attention, trend };
  }

  global.Body = { compute, analyze, ageAt };
})(window);
