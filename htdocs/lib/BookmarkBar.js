function BookmarkBar() {
    var me = this;
    me.modesToScan = ['lsb', 'usb', 'cw', 'am', 'sam', 'nfm'];
    me.localBookmarks = new BookmarkLocalStorage();
    me.$container = $('#openwebrx-bookmarks-container');
    me.bookmarks = {};
    // Full, profile-independent server bookmark list for cross-profile search
    me.allServerBookmarks = null;
    // Backing array for the current search result rows (index -> bookmark)
    me.lastResults = [];

    me.$container.on('click', '.bookmark', function(e){
        var $bookmark = $(e.target).closest('.bookmark');
        me.$container.find('.bookmark').removeClass('selected');
        if (UI.tuneBookmark($bookmark.data())) {
            $bookmark.addClass('selected');
            UI.toggleScanner(false);
        }
    });

    me.$container.on('click', '.action[data-action=edit]', function(e){
        e.stopPropagation();
        var $bookmark = $(e.target).closest('.bookmark');
        me.showEditDialog($bookmark.data());
    });

    me.$container.on('click', '.action[data-action=delete]', function(e){
        e.stopPropagation();
        var $bookmark = $(e.target).closest('.bookmark');
        me.localBookmarks.deleteBookmark($bookmark.data());
        me.loadLocalBookmarks();
    });

    var $bookmarkButton = $('#openwebrx-panel-receiver').find('.openwebrx-bookmark-button');
    if (typeof(Storage) !== 'undefined') {
        $bookmarkButton.show();
    } else {
        $bookmarkButton.hide();
    }
    $bookmarkButton.click(function(){
        me.showEditDialog();
    });
    $bookmarkButton.on('contextmenu', function(e){
        me.showSearchDialog();
        e.preventDefault();
    });

    // Add bookmark dialog
    me.$dialog = $('#openwebrx-dialog-bookmark');
    me.$dialog.find('.openwebrx-button[data-action=cancel]').click(function(){
        me.$dialog.hide();
    });
    me.$dialog.find('.openwebrx-button[data-action=submit]').click(function(){
        me.storeBookmark();
    });
    me.$dialog.find('form').on('submit', function(e){
        e.preventDefault();
        me.storeBookmark();
    });

    // Search bookmarks dialog
    me.$search = $('#openwebrx-dialog-search-bookmarks');
    me.$search.find('.openwebrx-button[data-action=cancel]').click(function(){
        me.$search.hide();
    });
    me.$search.find('.openwebrx-button[data-action=submit]').click(function(){
        me.searchBookmarks();
    });
    me.$search.find('form').on('submit', function(e){
        e.preventDefault();
        me.searchBookmarks();
    });
    // Clicking a result tunes it (switching profile first if needed)
    me.$search.on('click', '.search-result', function(){
        var idx = parseInt($(this).data('idx'));
        var b = me.lastResults[idx];
        if (b) me.tuneSearchResult(b);
    });
}

BookmarkBar.prototype.position = function(){
    var range = get_visible_freq_range();
    $('#openwebrx-bookmarks-container').find('.bookmark').each(function(){
        $(this).css('left', scale_px_from_freq($(this).data('frequency'), range));
    });
};

BookmarkBar.prototype.loadLocalBookmarks = function(){
    var bwh = bandwidth / 2;
    var start = center_freq - bwh;
    var end = center_freq + bwh;
    var bookmarks = this.localBookmarks.getBookmarks().filter(function(b){
        return b.frequency >= start && b.frequency <= end;
    });
    this.replace_bookmarks(bookmarks, 'local', true);
};

BookmarkBar.prototype.replace_bookmarks = function(bookmarks, source, editable) {
    editable = !!editable;
    bookmarks = bookmarks.map(function(b){
        b.source = source;
        b.editable = editable;
        return b;
    });
    this.bookmarks[source] = bookmarks;
    this.render();
};

BookmarkBar.prototype.render = function(){
    var bookmarks = Object.values(this.bookmarks).reduce(function(l, v){ return l.concat(v); });
    bookmarks = bookmarks.sort(function(a, b) {
        if (a.frequency != b.frequency) {
            return a.frequency - b.frequency;
        } else if (a.source == 'dial_frequencies') {
            // green bookmarks (bandplan) at the bottom
            return -1;
        } else {
            // then yellow bookmarks (server), then blue ones (local)
            return ((a.source == 'server') && (b.source == 'local')) ? -1 : 1;
        }
    });

    var elements = bookmarks.map(function(b) {
        var $bookmark = $(
            '<div class="bookmark" data-source="' + b.source + '"' + (b.editable?' editable="editable"':'') + '>' +
                '<div class="bookmark-actions">' +
                    '<div class="openwebrx-button action" data-action="edit"><svg viewBox="0 0 80 80"><use xlink:href="static/gfx/svg-defs.svg#edit"></use></svg></div>' +
                    '<div class="openwebrx-button action" data-action="delete"><svg viewBox="0 0 80 80"><use xlink:href="static/gfx/svg-defs.svg#trashcan"></use></svg></div>' +
                '</div>' +
                '<div class="bookmark-content">' + b.name + '</div>' +
            '</div>'
        );
        if (b.description) {
            $bookmark.prop('title', b.description);
        }
        $bookmark.data(b);
        return $bookmark;
    });

    this.$container.find('.bookmark').remove();
    this.$container.append(elements);
    this.position();
};

BookmarkBar.prototype.showSearchDialog = function(text = null) {
    // Pull the full, profile-independent list so search spans all profiles
    requestAllBookmarks();
    this.$search.show();
    this.$search.find('#search-results').html('');

    var $input = this.$search.find('#search-text');
    if (text != null) $input.val(text);
    $input.focus();
    $input.select();
};

BookmarkBar.prototype.showEditDialog = function(bookmark) {
    if (!bookmark) {
        var freq  = UI.getFrequency();
        var mode1 = UI.getModulation();
        var mode2 = UI.getUnderlying();
        if (!!mode1 && !!mode2) {
            // check for default underlying demod
            var m = Modes.findByModulation(mode1);
            if (m && m.underlying.indexOf(mode2) == 0) mode2 = '';
        }
        bookmark = {
            name        : '',
            frequency   : freq,
            modulation  : mode1,
            underlying  : mode2,
            description : '',
            scannable   : this.modesToScan.indexOf(mode1) >= 0
        }
    }
    this.$dialog.bookmarkDialog().setValues(bookmark);
    this.$dialog.show();
    this.$dialog.find('#name').focus();
};

BookmarkBar.prototype.sanitizeBookmark = function(b) {
    // must have name, frequency, and modulation
    if (!b.name || !b.frequency || !b.modulation)
        return "Must have name, frequency, and modulation.";

    // must have non-empty name
    b.name = b.name.trim();
    if (b.name.length <= 0) return "Must have a non-empty name.";

    // must have positive frequency
    b.frequency = Number(b.frequency);
    if (b.frequency <= 0) return "Frequency must be positive.";

    // must have valid modulation
    var mode = Modes.findByModulation(b.modulation);
    if (!mode) return "Must have valid modulation."

    // check that underlying demodulator is valid
    if (!b.underlying)
        b.underlying = '';
    else if (!mode.underlying)
        return "Must not have underlying modulation.";
    else if (mode.underlying.indexOf(b.underlying) < 0)
        return "Must have valid underlying modulation.";

    return null;
};

BookmarkBar.prototype.storeBookmark = function() {
    var me = this;
    var bookmark = this.$dialog.bookmarkDialog().getValues();
    if (!bookmark) return;

    var error = this.sanitizeBookmark(bookmark);
    if (error) { alert(error); return; }

    var bookmarks = me.localBookmarks.getBookmarks();

    if (!bookmark.id) {
        if (bookmarks.length) {
            bookmark.id = 1 + Math.max.apply(Math, bookmarks.map(function(b){ return b.id || 0; }));
        } else {
            bookmark.id = 1;
        }
    }

    bookmarks = bookmarks.filter(function(b) { return b.id !== bookmark.id; });
    bookmarks.push(bookmark);

    me.localBookmarks.setBookmarks(bookmarks);
    me.loadLocalBookmarks();
    me.$dialog.hide();
};

BookmarkBar.prototype.getAllBookmarks = function() {
    var sb = this.bookmarks['server'];
    var lb = this.bookmarks['local'];
    return !sb.length? (!lb.length? [] : lb) : !lb.length? sb : sb.concat(lb);
};

// Called when the server delivers the full, profile-independent bookmark list.
BookmarkBar.prototype.replaceAllServerBookmarks = function(list) {
    this.allServerBookmarks = (list || []).map(function(b){
        b.source = 'server';
        return b;
    });
    // Refresh an open search if the user has already typed something
    if (this.$search.is(':visible') && this.$search.find('#search-text').val()) {
        this.searchBookmarks();
    }
};

// Pool of bookmarks to search over: the full local set (localStorage, not
// band-filtered) plus the full server set once loaded. Falls back to the
// in-band server bookmarks until the full list arrives.
BookmarkBar.prototype.getSearchPool = function() {
    var local = this.localBookmarks.getBookmarks().map(function(b){
        b.source = 'local';
        return b;
    });
    var server = this.allServerBookmarks !== null
        ? this.allServerBookmarks
        : (this.bookmarks['server'] || []);
    return server.concat(local);
};

BookmarkBar.prototype.searchBookmarks = function() {
    var me = this;
    var text = this.$search.find('#search-text').val().toLowerCase();

    // Search bookmark names for text
    var result = this.getSearchPool().filter(function(b) {
        return b.name && b.name.toLowerCase().indexOf(text) >= 0;
    });

    // Sort results alphabetically, then by frequency
    result.sort(function(a, b) {
        return (a.name.localeCompare(b.name) || (a.frequency - b.frequency));
    });

    // Keep the backing array so click handlers can resolve a row to a bookmark
    me.lastResults = result;

    // Prepare search results — whole row is clickable (see constructor)
    var rows = result.map(function(b, i) {
        var loc = '';
        if (b.profile_name) {
            loc = ' <span class="search-profile' + (b.locked ? ' locked' : '') + '">'
                + (b.locked ? '&#128274; ' : '') + b.profile_name + '</span>';
        }
        return '<tr class="search-result" data-idx="' + i + '">'
            + '<td class="search-left">' + b.name + loc + '</td>'
            + '<td class="search-right">' + Utils.printFreq(b.frequency) + '</td></tr>';
    }).join('\n');

    // Output results
    this.$search.find('#search-results').html(
        '<table class="search-results">' + rows + '</table>'
    );
};

// Tune a search result. If it lies in the current profile's band, tune
// directly; otherwise switch to the covering profile first (unless that
// profile is locked or busy with another client) and tune once it is active.
BookmarkBar.prototype.tuneSearchResult = function(b) {
    var inBand = b.frequency >= center_freq - bandwidth / 2
              && b.frequency <= center_freq + bandwidth / 2;

    if (inBand) {
        UI.tuneBookmark(b);
        UI.toggleScanner(false);
        this.$search.hide();
        return;
    }

    // Cross-profile jump needs a server-resolved target profile
    if (!b.sdr_id || !b.profile_id) {
        divlog('Lesezeichen liegt außerhalb des aktuellen Profils und ist keinem Profil zugeordnet.', true);
        return;
    }

    // Do not steal a busy SDR from another client, and respect locked profiles
    if (isProfileBlocked(b.sdr_id, b.profile_id, b.locked)) {
        divlog('Zielprofil "' + (b.profile_name || b.profile_id) + '" ist belegt oder gesperrt.', true);
        return;
    }

    // Switch profile, then tune once the new profile config arrives
    setPendingBookmarkTune(b);
    switchToProfile(b.sdr_id + '|' + b.profile_id);
    this.$search.hide();
};
