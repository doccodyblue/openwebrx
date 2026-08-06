//
// Built-in Chat
//

function Chat() {}

// We start with these values
Chat.nickname = '';
Chat.nicknameRequired = false;

// Load chat settings from local storage.
Chat.loadSettings = function() {
    // Discard previously saved names that fail the current quality rule,
    // so their owners get the nickname modal again instead of silently
    // being rejected by the server.
    var savedName = LS.has('chatname')? LS.loadStr('chatname') : '';
    if (savedName && !this.isValidNickname(savedName)) savedName = '';
    this.setNickname(savedName);
    // Check if nickname is required and not set
    if (this.nicknameRequired && !this.nickname) {
        this.showNicknameModal();
    }
};

// Send nickname to server (call after WebSocket is connected)
Chat.sendNicknameToServer = function() {
    if (this.nickname && typeof ws !== 'undefined' && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({'type': 'setnickname', 'name': this.nickname}));
    }
};

// Weak-quality nickname rule, mirrored server-side (owrx/client.py):
// - at least 4 characters with a digit (every callsign passes naturally), OR
// - at least 6 letters for real names without digits ("Seefunker"),
// - and never a generic placeholder ("Anonym", "Gast", ...).
Chat.genericNicknames = ['anonym', 'anonymous', 'gast', 'guest', 'user', 'test',
    'tester', 'admin', 'unknown', 'nobody', 'niemand', 'keiner', 'name',
    'nickname', 'rufzeichen', 'callsign'];
Chat.isValidNickname = function(name) {
    if (typeof name !== 'string') return false;
    name = name.trim();
    if (name.length < 4) return false;
    if (this.genericNicknames.indexOf(name.toLowerCase()) >= 0) return false;
    return /\d/.test(name) || name.length >= 6;
};

// Show modal to require nickname input
Chat.showNicknameModal = function() {
    // Don't create multiple modals
    if (document.getElementById('nickname-modal-overlay')) {
        return;
    }
    // Create modal overlay
    var modal = document.createElement('div');
    modal.id = 'nickname-modal-overlay';
    modal.innerHTML = `
        <div class="nickname-modal">
            <h2>Willkommen!</h2>
            <p>Bitte gib dein Rufzeichen oder deinen Namen ein<br>
               <small>(z.B. DL1ABC oder Seefunker &mdash; keine Wegwerf-Namen wie &quot;Abc&quot;)</small>:</p>
            <input type="text" id="nickname-modal-input" placeholder="Rufzeichen / Nickname" maxlength="20" autofocus>
            <button id="nickname-modal-submit">OK</button>
        </div>
    `;
    document.body.appendChild(modal);

    var input = document.getElementById('nickname-modal-input');
    var submit = document.getElementById('nickname-modal-submit');

    var submitNickname = function() {
        var name = input.value.trim();
        if (Chat.isValidNickname(name)) {
            Chat.setNickname(name);
            modal.remove();
        } else {
            input.classList.add('error');
            input.value = '';
            input.placeholder = 'Bitte Rufzeichen oder richtigen Namen!';
        }
    };

    submit.addEventListener('click', submitNickname);
    input.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') submitNickname();
    });
    input.focus();
};

// Set chat nickname.
Chat.setNickname = function(nickname) {
    // Empty means "no name yet"; non-empty names must pass the quality
    // rule (the server enforces the same rule and would drop them anyway).
    if (nickname && !this.isValidNickname(nickname)) {
        $('#openwebrx-chat-name').addClass('error')
            .attr('title', 'Bitte Rufzeichen oder richtigen Namen (keine Wegwerf-Namen wie "Abc")');
        return;
    }
    $('#openwebrx-chat-name').removeClass('error').removeAttr('title');
    if (this.nickname !== nickname) {
        this.nickname = nickname;
        LS.save('chatname', nickname);
        $('#openwebrx-chat-name').val(nickname);
        // Send nickname to server so it knows who we are
        if (nickname && typeof ws !== 'undefined' && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({'type': 'setnickname', 'name': nickname}));
        }
    }
};

Chat.recvMessage = function(nickname, text, color = 'white', timestamp = null) {
    // Show chat panel only for new messages (not history)
    if (!timestamp) {
        toggle_panel('openwebrx-panel-log', true);
    }

    // Use provided timestamp or current time
    var time = timestamp ? timestamp : Date.now();

    // Format timestamp as "dd.mm. hh:mm" (local time)
    var d = (time instanceof Date) ? time : new Date(time);
    var pad = function(i) { return ('' + i).padStart(2, '0'); };
    var stamp = pad(d.getDate()) + '.' + pad(d.getMonth() + 1) + '.&nbsp;'
              + pad(d.getHours()) + ':' + pad(d.getMinutes());

    divlog(
        stamp + '&nbsp;['
      + '<span class="chatname" style="color:' + color + ';">'
      + Utils.htmlEscape(nickname) + '</span>]:&nbsp;'
      + '<span class="chatmessage">' + Utils.htmlEscape(text)
      + '</span>'
    );
};

Chat.sendMessage = function(text, nickname = '') {
    ws.send(JSON.stringify({
        'type': 'sendmessage', 'name': nickname, 'text': text
    }));
};

// Collect nick and message from controls and send message.
Chat.send = function() {
    this.setNickname($('#openwebrx-chat-name').val().trim());

    var msg = $('#openwebrx-chat-message').val().trim();
    if (msg.length > 0) this.sendMessage(msg, this.nickname);
    $('#openwebrx-chat-message').val('');
};

// Attach events to chat controls.
Chat.keyPress = function(event) {
    if (event.key === 'Enter') {
        event.preventDefault();
        this.send();
    }
};
