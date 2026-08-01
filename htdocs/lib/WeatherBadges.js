// WeatherBadges.js — Wetter-Badges (Temperatur + Blitzaktivität) im OpenWebRX-Header.
//
// Die Daten liefert das Weather Dashboard auf der DiskStation. Der Browser des
// Besuchers darf NIE direkt auf die LAN-Adresse (192.168.1.10) zeigen, deshalb
// proxt der OpenWebRX-Host serverseitig unter /wx/api/badge (siehe nginx-Snippet
// wx-badges.conf, 30 s Proxy-Cache).
(function () {
    var ENDPOINT   = '/wx/api/badge';
    var REFRESH_MS = 60000;

    function esc(s) {
        return String(s).replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
    }

    function trendArrow(t) {
        if (t === 'rising')  return '↗';
        if (t === 'falling') return '↘';
        return '→';
    }

    function hide() {
        $('#wx-badges').empty().css('display', 'none');
    }

    function render(data) {
        var $c = $('#wx-badges');
        if (!$c.length) return;
        var html = '';
        try {

        // --- Temperatur ------------------------------------------------------
        // temperature.c kann null sein -> Badge dann komplett weglassen.
        var t = data && data.temperature;
        if (t && t.c !== null && t.c !== undefined) {
            var tCls = 'wx-badge wx-temp' + (t.stale ? ' wx-stale' : '');
            var tTitle = 'Temperature' + (t.source ? ' (' + t.source + ')' : '') +
                         (t.stale ? ' – stale' : '');
            html += '<span class="' + tCls + '" title="' + esc(tTitle) + '">' +
                        '<span class="wx-ico">🌡</span>' +
                        t.c.toFixed(1) + '&nbsp;°C ' +
                        '<span class="wx-trend">' + trendArrow(t.trend) + '</span>' +
                    '</span>';
        }

        // --- Blitzaktivität --------------------------------------------------
        var l = data && data.lightning;
        if (l && l.source_ok) {
            var level = l.level || 'none';
            var body  = '<span class="wx-ico">⚡</span>';

            if (level === 'none' || !l.count_60min) {
                body += 'calm';
            } else {
                body += Math.round(l.nearest_km) + '&nbsp;km';
                if (l.nearest_dir) body += ' ' + esc(l.nearest_dir);
            }

            var lTitle = (l.count_60min || 0) + ' strikes/60 min';

            // storm is absent when no cell is approaching -> only show if present.
            if (l.storm && l.storm.eta_min !== null && l.storm.eta_min !== undefined) {
                body += ' <span class="wx-storm">⛈&nbsp;~' + Math.round(l.storm.eta_min) + '&nbsp;min';
                if (l.storm.from_dir) body += '&nbsp;' + esc(l.storm.from_dir);
                body += '</span>';
                lTitle += ' · cell ETA ~' + Math.round(l.storm.eta_min) + ' min from ' +
                          (l.storm.from_dir || '?');
            }

            html += '<span class="wx-badge wx-lightning wx-lvl-' + esc(level) + '" title="' +
                        esc(lTitle) + '">' + body + '</span>';
        }

        } catch (e) {
            // Unerwartete Datenstruktur o. Ä. -> stillschweigend nichts anzeigen.
            html = '';
        }

        if (html) {
            $c.html(html).css('display', 'flex');
        } else {
            hide();
        }
    }

    function update() {
        // Fallstrick #2: Cache-Buster auf die volle Minute runden, damit Besucher
        // nicht am Proxy-Cache vorbei aufs Dashboard durchschlagen.
        var bust = Math.floor(Date.now() / 60000);
        $.ajax({ url: ENDPOINT + '?lang=en&_=' + bust, dataType: 'json', timeout: 5000 })
            .done(render)
            .fail(function () {
                // Fehler / Dashboard offline / Proxy nicht vorhanden (Fork woanders
                // deployt) -> ausblenden statt Fehler zeigen.
                hide();
            });
    }

    $(function () {
        if (!$('#wx-badges').length) return;
        update();
        setInterval(update, REFRESH_MS);
    });
})();
