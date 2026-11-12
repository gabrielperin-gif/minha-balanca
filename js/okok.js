/*
 * Decodificador das balanças do app "OKOK International" (chip Chipsea).
 *
 * Essas balanças NÃO aceitam conexão: elas apenas "anunciam" o peso por
 * Bluetooth (advertising), dentro do campo "Manufacturer Data".
 * O mapeamento dos bytes segue o trabalho de engenharia reversa do projeto
 * openScale (OkOkHandler.kt), que identificou 4 variantes:
 *
 *   V20  chave 0x20CA  peso bytes 8-9, impedância 10-11, flag byte 6, checksum byte 12
 *   V11  chave 0x11CA  peso bytes 3-4, propriedades byte 9, checksum byte 16
 *   VF0  chave 0xF0FF  peso bytes 3(MSB)-2(LSB) / 10
 *   C0   chave 0x??C0  peso bytes 0-1, impedância 2-3, atributos byte 6
 *
 * Em todas, a chave (company id) já vem separada dos dados, tanto no Android
 * quanto no Web Bluetooth, então os índices abaixo são relativos aos dados.
 */
(function (global) {
  'use strict';

  const MANUF_V20 = 0x20ca;
  const MANUF_V11 = 0x11ca;
  const MANUF_VF0 = 0xf0ff;

  // Todas as chaves que o Chrome precisa "liberar" no modo de dispositivo
  // (optionalManufacturerData). C0 = qualquer chave cujo byte baixo é 0xC0.
  const MANUFACTURER_IDS = (function () {
    const ids = [MANUF_V20, MANUF_V11, MANUF_VF0];
    for (let hi = 0; hi < 256; hi++) ids.push((hi << 8) | 0xc0);
    return ids;
  })();

  const KNOWN_NAMES = ['adv', 'chipsea-ble', 'okok', 'yoda0', 'yoda1'];

  function u16(b, msb, lsb) {
    return ((b[msb] & 0xff) << 8) | (b[lsb] & 0xff);
  }

  function divisorFromBits(props) {
    // (props >> 1) & 3 : 0 -> 10, 1 -> 1, 2 -> 100, 3 -> 10
    return [10, 1, 100, 10][(props >> 1) & 3];
  }

  // Converte para kg conforme a unidade configurada na balança.
  function toKg(raw, props, b, stoneIdx, poundIdx) {
    const div = divisorFromBits(props);
    switch ((props >> 3) & 3) {
      case 0: return raw / div;                 // kg
      case 1: return raw / div / 2;             // jin (catty chinês)
      case 2: return (raw / div) / 2.204623;    // libras
      case 3: {                                 // stones + libras
        const stones = b[stoneIdx] & 0xff;
        const pounds = (b[poundIdx] & 0xff) / div;
        return stones * 6.350293 + pounds * 0.453592;
      }
    }
    return raw / div;
  }

  function xorChecksum(seed, b, count) {
    let cs = seed;
    for (let i = 0; i < count; i++) cs ^= b[i];
    return cs & 0xff;
  }

  function plausible(kg) {
    return Number.isFinite(kg) && kg >= 2 && kg <= 250;
  }

  /**
   * Tenta decodificar um bloco de manufacturer data.
   * @param {number} key   company id (16 bits)
   * @param {Uint8Array} b dados (sem o company id)
   * @returns {{variant:string, weight:number, impedance:number|null, stable:boolean|null}|null}
   */
  function parseBlock(key, b) {
    if (key === MANUF_V20 && b.length >= 13) {
      if (xorChecksum(0x20, b, 12) !== b[12]) return null;
      const flags = b[6];
      const div = (flags & 0x04) ? 100 : 10;
      const weight = u16(b, 8, 9) / div;
      const imp = u16(b, 10, 11) / 10;
      if (!plausible(weight)) return null;
      return { variant: 'V20', weight, impedance: imp > 0 ? imp : null, stable: !!(flags & 0x01) };
    }

    if (key === MANUF_V11 && b.length >= 17) {
      if (xorChecksum(0xca ^ 0x11, b, 16) !== b[16]) return null;
      const weight = toKg(u16(b, 3, 4), b[9], b, 3, 4);
      if (!plausible(weight)) return null;
      return { variant: 'V11', weight, impedance: null, stable: null };
    }

    if (key === MANUF_VF0 && b.length >= 4) {
      const weight = u16(b, 3, 2) / 10; // ordem invertida de propósito
      if (!plausible(weight)) return null;
      return { variant: 'VF0', weight, impedance: null, stable: null };
    }

    if ((key & 0xff) === 0xc0 && b.length >= 13) {
      const attrib = b[6];
      const weight = toKg(u16(b, 0, 1), attrib, b, 0, 1);
      const imp = u16(b, 2, 3) / 10;
      if (!plausible(weight)) return null;
      return { variant: 'C0', weight, impedance: imp > 0 ? imp : null, stable: !!(attrib & 0x01) };
    }

    return null;
  }

  /**
   * Decodifica o Map<number, DataView> que o Web Bluetooth entrega em
   * event.manufacturerData.
   */
  function parseManufacturerData(map) {
    if (!map) return null;
    for (const [key, dv] of map) {
      const b = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
      const r = parseBlock(key, b);
      if (r) return r;
    }
    return null;
  }

  function looksLikeScaleName(name) {
    if (!name) return false;
    const n = name.toLowerCase();
    return KNOWN_NAMES.some((k) => n.startsWith(k));
  }

  function hex(b) {
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');
  }

  // Monta um quadro V20 válido — usado pelo modo de simulação.
  function buildV20Frame(weightKg, impedanceOhm, stable) {
    const b = new Uint8Array(19);
    const raw = Math.round(weightKg * 100);
    b[6] = (stable ? 0x01 : 0) | 0x04; // divisor 100
    b[8] = (raw >> 8) & 0xff;
    b[9] = raw & 0xff;
    const imp = Math.round((impedanceOhm || 0) * 10);
    b[10] = (imp >> 8) & 0xff;
    b[11] = imp & 0xff;
    b[12] = xorChecksum(0x20, b, 12);
    return b;
  }

  global.OKOK = {
    MANUFACTURER_IDS,
    parseBlock,
    parseManufacturerData,
    looksLikeScaleName,
    buildV20Frame,
    hex,
  };
})(window);
