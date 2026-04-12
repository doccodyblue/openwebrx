//
// Built-in Chat
//

function Chat() {}

// We start with these values
Chat.nickname = '';
Chat.nicknameRequired = false;

// Load chat settings from local storage.
Chat.loadSettings = function() {
    this.setNickname(LS.has('chatname')? LS.loadStr('chatname') : '');
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
            <p>Bitte gib deinen Namen oder dein Rufzeichen ein:</p>
            <input type="text" id="nickname-modal-input" placeholder="Rufzeichen / Nickname" maxlength="20" autofocus>
            <button id="nickname-modal-submit">OK</button>
        </div>
    `;
    document.body.appendChild(modal);

    var input = document.getElementById('nickname-modal-input');
    var submit = document.getElementById('nickname-modal-submit');

    var submitNickname = function() {
        var name = input.value.trim();
        if (name.length >= 2) {
            Chat.setNickname(name);
            modal.remove();
        } else {
            input.classList.add('error');
            input.placeholder = 'Mindestens 2 Zeichen!';
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

    divlog(
        Utils.HHMMSS(time, true) + '&nbsp;['
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
