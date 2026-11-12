/*
 * Definição e desenho dos índices: cartões com barra de faixas, explicação de
 * cada índice, pontuação e análise.
 */
(function (global) {
  'use strict';

  const fmt = (n, d = 1) => (n == null || !Number.isFinite(n) ? '--' : n.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /*
   * Cada índice:
   *  value(r)  -> número exibido
   *  band      -> chave em r.bands / r.ratings (opcional)
   *  bandValue -> valor usado na barra, se diferente do exibido
   *  scale(r)  -> [mín, máx] da barra
   *  measured  -> true se vem direto da balança
   */
  const METRICS = [
    {
      key: 'weight', label: 'Peso', unit: 'kg', dec: 2, measured: true,
      value: (r) => r.weight,
      sub: (r) => (r.healthyMin ? `Faixa saudável: ${fmt(r.healthyMin)}–${fmt(r.healthyMax)} kg` : ''),
      info: 'Medido diretamente pela balança.',
    },
    {
      key: 'bmi', label: 'IMC', unit: '', dec: 1, band: 'bmi',
      value: (r) => r.bmi, scale: () => [15, 40],
      info: 'Índice de Massa Corporal = peso ÷ altura². É uma referência simples da OMS, mas não separa músculo de gordura: pessoas musculosas podem ter IMC alto e estar saudáveis.',
    },
    {
      key: 'fat', label: 'Gordura corporal', unit: '%', dec: 1, band: 'fat',
      value: (r) => r.fat, scale: (r) => [5, r.bands.fat[2].to + 12],
      info: 'Porcentagem do peso que é gordura. Calculada a partir da impedância: a gordura conduz pouca eletricidade e os tecidos magros (cheios de água) conduzem bem. Equação de Sun et al. (2003). As faixas variam com sexo e idade (Gallagher, 2000).',
    },
    {
      key: 'visceral', label: 'Gordura visceral', unit: 'nível', dec: 0, band: 'visceral',
      value: (r) => r.visceral, scale: () => [1, 20],
      info: 'Gordura que fica dentro da barriga, em volta dos órgãos, e é a mais ligada a diabetes e doenças do coração. Uma balança de pés não consegue medi-la diretamente: este nível (1 a 30) é uma estimativa a partir da gordura total, idade e sexo. Se você informar a cintura no Perfil, a estimativa fica melhor.',
    },
    {
      key: 'skeletal', label: 'Músculo esquelético', unit: 'kg', dec: 1, band: 'skeletal',
      value: (r) => r.skeletal, bandValue: (r) => r.skeletalPct,
      scale: (r) => [r.bands.skeletal[0].to - 10, r.bands.skeletal[1].to + 8],
      sub: (r) => `${fmt(r.skeletalPct)}% do peso`,
      info: 'Músculos ligados aos ossos, que você treina na academia. Calculado pela equação de Janssen et al. (2000). As faixas são a média ± 1 desvio-padrão da população adulta, em % do peso.',
    },
    {
      key: 'muscleMass', label: 'Massa muscular', unit: 'kg', dec: 1,
      value: (r) => r.muscleMass,
      info: 'Tudo que não é gordura nem osso: músculos esqueléticos, coração, órgãos e a água que eles contêm. É o número que balanças comerciais chamam de "massa muscular" e por isso é maior que o músculo esquelético.',
    },
    {
      key: 'leanMass', label: 'Massa magra', unit: 'kg', dec: 1,
      value: (r) => r.leanMass,
      info: 'Peso total menos a gordura: músculos, órgãos, ossos e água.',
    },
    {
      key: 'fatMass', label: 'Massa de gordura', unit: 'kg', dec: 1,
      value: (r) => r.fatMass,
      info: 'Quantos quilos do seu peso são gordura. É o melhor número para acompanhar se uma dieta está funcionando.',
    },
    {
      key: 'water', label: 'Água corporal', unit: '%', dec: 1, band: 'water',
      value: (r) => r.water, scale: (r) => (r.male ? [40, 75] : [35, 70]),
      info: 'Porcentagem do peso que é água. A massa magra tem, em média, 73% de água (Wang, 1999). Varia com o horário, com o que você bebeu e com o suor.',
    },
    {
      key: 'protein', label: 'Proteína', unit: '%', dec: 1, band: 'protein',
      value: (r) => r.protein, scale: () => [10, 25],
      info: 'Porcentagem do peso formada por proteínas, a maior parte nos músculos. Estimada pelas proporções médias da massa magra (água, proteína e minerais).',
    },
    {
      key: 'bone', label: 'Massa óssea', unit: 'kg', dec: 1, band: 'bone',
      value: (r) => r.bone, scale: (r) => [r.boneRef - 1.2, r.boneRef + 1.2],
      info: 'Peso estimado dos minerais dos ossos. A balança não mede osso: é uma proporção média da massa magra. Não serve para diagnosticar osteoporose; para isso existe a densitometria.',
    },
    {
      key: 'bmr', label: 'Metabolismo basal', unit: 'kcal', dec: 0,
      value: (r) => r.bmr,
      sub: () => 'gasto em repouso por dia',
      info: 'Calorias que seu corpo gasta por dia só para se manter vivo, em repouso. Com bioimpedância usa a fórmula de Katch-McArdle (baseada na massa magra); sem ela, Mifflin-St Jeor. Somando as atividades do dia, o gasto total costuma ser 1,2 a 1,7 vez esse valor.',
    },
    {
      key: 'metabolicAge', label: 'Idade metabólica', unit: 'anos', dec: 0, band: 'metabolicAge',
      value: (r) => r.metabolicAge, scale: (r) => [r.age - 20, r.age + 20],
      sub: (r) => `sua idade: ${r.age}`,
      info: 'A idade em que uma pessoa média, com seu peso e altura, teria o mesmo metabolismo que você. Mais músculo deixa o metabolismo "mais jovem".',
    },
    {
      key: 'whtr', label: 'Cintura ÷ altura', unit: '', dec: 2, band: 'whtr',
      value: (r) => r.whtr, scale: () => [0.35, 0.75],
      info: 'Relação entre a cintura (informada no Perfil) e a altura. Acima de 0,5 indica acúmulo de gordura na barriga e maior risco cardiovascular (Ashwell, 2012). Atualize a cintura no Perfil de tempos em tempos.',
    },
    {
      key: 'ideal', label: 'Peso ideal', unit: 'kg', dec: 1,
      value: (r) => r.idealWeight,
      sub: (r) => {
        const d = r.weight - r.idealWeight;
        return Math.abs(d) < 0.5 ? 'você está no peso ideal' : `${fmt(Math.abs(d))} kg ${d > 0 ? 'acima' : 'abaixo'}`;
      },
      info: 'Peso que corresponde a um IMC de 22, o meio da faixa saudável para sua altura. É só uma referência: se você tem muito músculo, seu peso saudável pode ser maior.',
    },
    {
      key: 'impedance', label: 'Impedância', unit: 'Ω', dec: 0, measured: true,
      value: (r) => r.impedance,
      info: 'Resistência do corpo a uma corrente elétrica fraquinha que passa de um pé ao outro. É o único dado da bioimpedância que a balança mede de fato; os outros índices são calculados a partir dele. Valores mais baixos indicam mais água e músculo.',
    },
  ];

  const BY_KEY = Object.fromEntries(METRICS.map((m) => [m.key, m]));

  function barHTML(def, r) {
    const bands = r.bands && r.bands[def.band];
    if (!bands || !def.scale) return '';
    const [lo, hi] = def.scale(r);
    const v = def.bandValue ? def.bandValue(r) : def.value(r);
    const pos = (x) => Math.min(100, Math.max(0, ((x - lo) / (hi - lo)) * 100));
    let prev = lo;
    const segs = bands.map((b) => {
      const to = b.to == null ? hi : Math.min(hi, b.to);
      const width = Math.max(0, pos(to) - pos(prev));
      prev = to;
      return `<span class="seg-${b.level}" style="width:${width.toFixed(2)}%"></span>`;
    }).join('');
    return `<div class="bar" aria-hidden="true">${segs}<i style="left:${pos(v).toFixed(1)}%"></i></div>`;
  }

  function cardsHTML(r) {
    return METRICS.map((def) => {
      const v = def.value(r);
      if (v == null || !Number.isFinite(v)) return '';
      const rt = def.band && r.ratings ? r.ratings[def.band] : null;
      const sub = def.sub ? def.sub(r) : '';
      return `<button class="metric" data-metric="${def.key}">
        <div class="label">${def.label}${def.measured ? ' <span class="measured">medido</span>' : ''}</div>
        <div class="value">${fmt(v, def.dec)}${def.unit ? `<small>${def.unit}</small>` : ''}</div>
        ${rt ? `<span class="tag ${rt.level}">${rt.label}</span>` : ''}
        ${sub ? `<div class="sub">${esc(sub)}</div>` : ''}
        ${barHTML(def, r)}
      </button>`;
    }).join('');
  }

  function bandsText(def, r) {
    const bands = r.bands && r.bands[def.band];
    if (!bands) return '';
    const d = def.key === 'whtr' ? 2 : def.key === 'visceral' || def.key === 'metabolicAge' ? 0 : 1;
    const unit = def.band === 'skeletal' ? '% do peso' : def.unit === '%' ? '%' : def.unit === 'kg' ? ' kg' : def.unit === 'anos' ? ' anos' : '';
    let prev = null;
    const rows = bands.map((b) => {
      // Índices inteiros (visceral, idade): "10 a 12" em vez de "10 a 13".
      const upper = d === 0 && b.to != null ? b.to - 1 : b.to;
      const range = prev == null ? (d === 0 ? `até ${fmt(upper, d)}` : `abaixo de ${fmt(b.to, d)}`)
        : b.to == null ? `${fmt(prev, d)} ou mais` : `${fmt(prev, d)} a ${fmt(upper, d)}`;
      prev = b.to;
      return `<li><span class="tag ${b.level}">${b.label}</span> ${range}${unit}</li>`;
    });
    return `<ul class="bands">${rows.join('')}</ul>`;
  }

  function infoHTML(key, r) {
    const def = BY_KEY[key];
    if (!def) return '';
    const v = def.value(r);
    const rt = def.band && r.ratings ? r.ratings[def.band] : null;
    return `<div class="info-value">${fmt(v, def.dec)}<small>${def.unit}</small> ${rt ? `<span class="tag ${rt.level}">${rt.label}</span>` : ''}</div>
      ${barHTML(def, r)}
      <p>${esc(def.info)}</p>
      ${bandsText(def, r)}
      <p class="muted small">${def.measured ? 'Valor medido pela balança.' : 'Valor estimado por cálculo — veja "Sobre os números" no Perfil.'}</p>`;
  }

  function scoreHTML(r) {
    const s = r.score;
    const C = 2 * Math.PI * 42;
    return `<div class="score-ring ${s.level}">
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <circle cx="50" cy="50" r="42" class="track"/>
          <circle cx="50" cy="50" r="42" class="fill" stroke-dasharray="${((s.value / 100) * C).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 50 50)"/>
        </svg>
        <div class="score-num">${s.value}<small>/100</small></div>
      </div>
      <div class="score-text">
        <div class="score-label">${s.label}</div>
        <div class="muted">Tipo corporal: <b>${esc(r.bodyType)}</b></div>
        ${r.hasImpedance ? '' : '<div class="muted small">Sem bioimpedância nesta pesagem</div>'}
      </div>`;
  }

  function analysisHTML(a) {
    const li = (arr, cls) => arr.map((t) => `<li class="${cls}">${esc(t)}</li>`).join('');
    return `<p>${esc(a.summary)}</p>
      ${a.trend ? `<p class="trend">${esc(a.trend)}</p>` : ''}
      ${a.attention.length ? `<h3>Pontos de atenção</h3><ul class="analysis">${li(a.attention, 'warn')}</ul>` : ''}
      ${a.good.length ? `<h3>Pontos positivos</h3><ul class="analysis">${li(a.good, 'ok')}</ul>` : ''}
      <p class="muted small">Para comparar pesagens, pese-se sempre no mesmo horário, de preferência de manhã, em jejum, depois de ir ao banheiro e descalço. Esta análise é informativa e não substitui avaliação de um profissional de saúde.</p>`;
  }

  global.Metrics = { METRICS, cardsHTML, infoHTML, scoreHTML, analysisHTML, label: (k) => BY_KEY[k] && BY_KEY[k].label };
})(window);
