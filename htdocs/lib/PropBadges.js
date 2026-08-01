// PropBadges.js — Ausbreitungs-Badges (MUF + K-Index) im OpenWebRX-Header.
//
// Daten liefert der serverseitige Aggregator /prop/summary (owrx/controllers/
// propagation.py), der kc2g (Ionosonden -> MUF) und NOAA (planetarer Kp) holt,
// cached und zu einem JSON mergt. Kein CORS, keine LAN-Sorgen, Dienste werden
// nicht von jedem Browser einzeln getroffen.
(function () {
    var ENDPOINT   = '/prop/summary';
    var REFRESH_MS = 300000;  // 5 min – Ausbreitung ändert sich langsam
    var RECOLOR_MS = 1000;    // MUF-Chip gegen die abgestimmte Frequenz nachfärben

    var lastMuf = null;       // zuletzt gelieferter MUF-Wert in MHz (für die Färbung)

    function hide() {
        $('#prop-badges').empty().css('display', 'none');
    }

    // Aktuell abgestimmte Frequenz in Hz (center_freq + Demodulator-Offset) oder null.
    function getTunedHz() {
        try {
            var panel = UI.getDemodulatorPanel();
            var d = panel && panel.getDemodulator();
            if (!d || typeof center_freq === 'undefined' || center_freq === null) return null;
            return center_freq + d.get_offset_frequency();
        } catch (e) {
            return null;
        }
    }

    // Verdikt: liegt die abgestimmte Frequenz unter/nahe/über der MUF?
    // Nur auf KW (< 30 MHz) sinnvoll; darüber neutral (leere Klasse).
    function mufVerdict(tunedHz, muf) {
        if (muf === null || muf === undefined || tunedHz === null) return { cls: '', msg: '' };
        var mhz = tunedHz / 1e6;
        if (!(mhz > 0) || mhz >= 30) return { cls: '', msg: '' };
        var f = mhz / muf;
        var fmt = mhz.toFixed(mhz < 10 ? 3 : 2).replace(/0+$/, '').replace(/\.$/, '');
        if (f <= 0.90) return { cls: 'prop-muf-open',     msg: fmt + ' MHz unter MUF → Skip möglich' };
        if (f <= 1.00) return { cls: 'prop-muf-marginal', msg: fmt + ' MHz nahe MUF → grenzwertig' };
        return { cls: 'prop-muf-closed', msg: fmt + ' MHz über MUF → kein F2-Skip' };
    }

    function recolorMuf() {
        var $b = $('#prop-muf');
        if (!$b.length) return;
        var v = mufVerdict(getTunedHz(), lastMuf);
        $b.removeClass('prop-muf-open prop-muf-marginal prop-muf-closed');
        if (v.cls) $b.addClass(v.cls);
        var base = $b.attr('data-base-title') || '';
        $b.attr('title', v.msg ? base + ' · ' + v.msg : base);
    }

    function render(data) {
        var $c = $('#prop-badges');
        if (!$c.length) return;
        var html = '';
        try {

        // --- MUF (nächstgelegene Ionosonde) ----------------------------------
        lastMuf = null;
        var m = data && data.muf;
        if (m && m.mhz !== null && m.mhz !== undefined) {
            lastMuf = m.mhz;
            var mCls = 'wx-badge prop-muf' + (m.stale ? ' wx-stale' : '');
            var mTitle = ('MUF' + (m.station ? ' – ' + m.station : '') +
                         (m.dist_km !== null && m.dist_km !== undefined ? ' (' + m.dist_km + ' km)' : '') +
                         (m.age_min !== null && m.age_min !== undefined ? ', ' + m.age_min + ' min alt' : '') +
                         (m.stale ? ' – veraltet' : '')).replace(/"/g, '');
            html += '<span id="prop-muf" class="' + mCls + '" data-base-title="' + mTitle + '" title="' + mTitle + '">' +
                        '<span class="wx-ico">📡</span>MUF ' + m.mhz.toFixed(1) + '&nbsp;MHz' +
                    '</span>';
        }

        // --- K-Index (geomagnetische Aktivität) ------------------------------
        var k = data && data.k;
        if (k && k.kp !== null && k.kp !== undefined) {
            var level = k.level || 'quiet';
            var kTitle = 'Planetarer K-Index Kp ' + k.kp +
                         (k.a !== null && k.a !== undefined ? ' · A ' + k.a : '') +
                         (k.age_min !== null && k.age_min !== undefined ? ' · ' + k.age_min + ' min alt' : '') +
                         (level === 'storm' ? ' · geomagn. Sturm, Aurora möglich' :
                          level === 'active' ? ' · unruhig' : '');
            // Kp ganzzahlig anzeigen, wenn ganz (1.0 -> 1), sonst eine Stelle.
            var kp = (k.kp % 1 === 0) ? String(k.kp) : k.kp.toFixed(1);
            html += '<span class="wx-badge prop-k prop-k-' + level + '" title="' + kTitle.replace(/"/g, '') + '">' +
                        '<span class="wx-ico">🧭</span>K ' + kp +
                    '</span>';
        }

        } catch (e) {
            html = '';
        }

        if (html) {
            $c.html(html).css('display', 'flex');
            recolorMuf();
        } else {
            hide();
        }
    }

    function update() {
        // Cache-Buster auf 5-min-Raster runden (passt zum Browser-Cache max-age=300).
        var bust = Math.floor(Date.now() / REFRESH_MS);
        $.ajax({ url: ENDPOINT + '?_=' + bust, dataType: 'json', timeout: 8000 })
            .done(render)
            .fail(function () {
                // Aggregator/Quellen weg -> ausblenden statt Fehler zeigen.
                hide();
            });
    }

    $(function () {
        if (!$('#prop-badges').length) return;
        update();
        setInterval(update, REFRESH_MS);
        // MUF-Chip laufend gegen die aktuell abgestimmte Frequenz nachfärben.
        setInterval(recolorMuf, RECOLOR_MS);
    });
})();
