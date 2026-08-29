/*
 * w8rez — EPS file handling in the browser.
 *
 * An EPS file is PostScript: browsers cannot rasterise it natively. Strategy:
 *   1. The companion server (server.js) converts it with ghostscript when it
 *      is installed (POST /api/eps-to-png).
 *   2. Browser-only fallback: many EPS files (Illustrator/Photoshop) embed a
 *      JPEG preview. We extract it by scanning for JPEG markers
 *      (SOI 0xFFD8 … EOI 0xFFD9) and keep the largest stream found.
 *
 * UMD: browser (window.W8rez.Eps) and Node (require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.W8rez = root.W8rez || {};
    root.W8rez.Eps = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Bytes scanned when sniffing the DSC header. */
  const HEADER_SCAN = 512;

  /**
   * Extracts the largest embedded JPEG preview from an EPS file.
   *
   * Heuristic: inside the binary section, an SOI (0xFFD8) followed later by an
   * EOI (0xFFD9) delimits a JPEG. JPEG entropy data pads 0xFF with 0x00, so a
   * real 0xFFD9 can only be the EOI (restart markers are 0xFFD0–0xFFD7).
   * Thumbnails may exist next to the full preview, so the largest stream wins.
   *
   * @param {ArrayBuffer|Uint8Array} buffer raw EPS bytes
   * @returns {Uint8Array|null} the JPEG bytes, or null when none is found
   */
  function extractJpegPreview(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const len = bytes.length;
    let best = null; // { start, size }
    let i = 0;

    while (i < len - 1) {
      if (bytes[i] === 0xff && bytes[i + 1] === 0xd8) {
        // scan forward for the matching EOI
        let j = i + 2;
        let eoi = -1;
        while (j < len - 1) {
          if (bytes[j] === 0xff && bytes[j + 1] === 0xd9) {
            eoi = j + 1;
            break;
          }
          j++;
        }
        if (eoi !== -1) {
          const size = eoi - i + 1;
          if (!best || size > best.size) best = { start: i, size: size };
          i = eoi + 1; // keep scanning; a larger preview may follow
          continue;
        }
      }
      i++;
    }

    if (!best) return null;
    return bytes.slice(best.start, best.start + best.size);
  }

  /**
   * Decodes the first bytes of a buffer as ISO-8859-1 text.
   * Uses TextDecoder when available (browsers) and falls back to a manual
   * decode — Uint8Array has no encoding-aware toString in the browser.
   */
  function decodeLatin1(bytes, length) {
    const view = bytes.subarray(0, Math.min(length, bytes.length));
    if (typeof TextDecoder !== 'undefined') {
      try {
        return new TextDecoder('iso-8859-1').decode(view);
      } catch (_) {
        /* fall through to the manual decoder */
      }
    }
    let out = '';
    for (let i = 0; i < view.length; i++) out += String.fromCharCode(view[i]);
    return out;
  }

  /**
   * Sniffs whether a buffer looks like an EPS
   * (DSC header: `%!PS-Adobe-x.y EPSF`).
   *
   * @param {ArrayBuffer|Uint8Array} buffer
   * @returns {boolean}
   */
  function looksLikeEps(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    return /%!PS-Adobe-\d+\.\d+\s+(EPSF-\d+\.\d+)?/i.test(decodeLatin1(bytes, HEADER_SCAN));
  }

  return {
    extractJpegPreview,
    looksLikeEps,
  };
});
