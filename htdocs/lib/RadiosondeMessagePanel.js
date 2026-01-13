function RadiosondeMessagePanel(el) {
    MessagePanel.call(this, el);
    this.initClearTimer();
    this.modes = ['RS41', 'DFM'];
}

RadiosondeMessagePanel.prototype = Object.create(MessagePanel.prototype);

RadiosondeMessagePanel.prototype.supportsMessage = function(message) {
    return this.modes.indexOf(message['mode']) >= 0;
};

RadiosondeMessagePanel.prototype.render = function() {
    $(this.el).append($(
        '<table>' +
            '<thead><tr>' +
                '<th class="time">UTC</th>' +
                '<th class="id">ID</th>' +
                '<th class="type">Type</th>' +
                '<th class="altitude">Alt</th>' +
                '<th class="climb">Climb</th>' +
                '<th class="temp">Temp</th>' +
                '<th class="locator">Position</th>' +
            '</tr></thead>' +
            '<tbody></tbody>' +
        '</table>'
    ));
};

RadiosondeMessagePanel.prototype.pushMessage = function(msg) {
    var dominated = this.currentMode && this.currentMode !== msg['mode'];
    if (dominated) return;
    this.currentMode = msg['mode'];

    var $b = $(this.el).find('tbody');

    // Timestamp formatieren
    var timestamp = '';
    if (msg.datetime) {
        var d = new Date(msg.datetime);
        timestamp = ('0' + d.getUTCHours()).slice(-2) + ':' +
                   ('0' + d.getUTCMinutes()).slice(-2) + ':' +
                   ('0' + d.getUTCSeconds()).slice(-2);
    } else if (msg.timestamp) {
        timestamp = Utils.HHMMSS(msg.timestamp);
    }

    var id = msg.id || msg.serial || '?';
    var type = msg.type || msg.mode || '?';
    var alt = msg.altitude ? msg.altitude.toFixed(0) + 'm' : (msg.alt ? msg.alt.toFixed(0) + 'm' : '?');
    var climb = msg.vel_v ? (msg.vel_v > 0 ? '+' : '') + msg.vel_v.toFixed(1) + 'm/s' : '?';
    var temp = (msg.temp !== undefined && msg.temp !== null) ? msg.temp.toFixed(1) + '°C' : '?';

    // Position als Link zur Karte
    var position = '?';
    if (msg.lat && msg.lon) {
        var lat = msg.lat.toFixed(4);
        var lon = msg.lon.toFixed(4);
        position = '<a href="https://www.google.com/maps?q=' + msg.lat + ',' + msg.lon + '" target="_blank">' +
                   lat + ', ' + lon + '</a>';
    }

    // Farbe basierend auf Steig-/Sinkrate
    var climbClass = '';
    if (msg.vel_v) {
        if (msg.vel_v < -10) climbClass = 'sonde-falling-fast';
        else if (msg.vel_v < 0) climbClass = 'sonde-falling';
        else if (msg.vel_v > 2) climbClass = 'sonde-rising';
    }

    // Existierende Zeile für diese Sonde suchen oder neue erstellen
    var $existingRow = $b.find('tr[data-sonde-id="' + id + '"]');
    var rowHtml =
        '<td class="time">' + timestamp + '</td>' +
        '<td class="id">' + id + '</td>' +
        '<td class="type">' + type + '</td>' +
        '<td class="altitude">' + alt + '</td>' +
        '<td class="climb ' + climbClass + '">' + climb + '</td>' +
        '<td class="temp">' + temp + '</td>' +
        '<td class="locator">' + position + '</td>';

    if ($existingRow.length > 0) {
        // Update existierende Zeile
        $existingRow.html(rowHtml);
    } else {
        // Neue Zeile hinzufügen
        $b.append($('<tr data-sonde-id="' + id + '">' + rowHtml + '</tr>'));
    }

    this.scrollToBottom();
};

RadiosondeMessagePanel.prototype.clearContent = function() {
    var $b = $(this.el).find('tbody');
    $b.empty();
    this.currentMode = null;
};

$.fn.radiosondeMessagePanel = function() {
    if (!this.data('panel')) {
        this.data('panel', new RadiosondeMessagePanel(this));
    }
    return this.data('panel');
};
