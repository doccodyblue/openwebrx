// DX Cluster Overlay - Shows DX spots on waterfall

function DXCluster() {
    var me = this;
    me.spots = [];
    me.maxAge = 15 * 60 * 1000; // 15 minutes in ms
    me.maxSpots = 50;
    
    // Update positions when waterfall scrolls
    $(window).on('resize', function() { me.render(); });
}

DXCluster.prototype.addSpotFromServer = function(spot) {
    // spot from server: { frequency, dx_call, spotter, comment, timestamp }
    // Remove old spot for same callsign
    this.spots = this.spots.filter(function(s) {
        return s.dx_call !== spot.dx_call;
    });
    
    spot.time = spot.timestamp * 1000; // Convert to JS timestamp
    this.spots.push(spot);
    
    // Keep only recent spots
    if (this.spots.length > this.maxSpots) {
        this.spots = this.spots.slice(-this.maxSpots);
    }
    
    console.log('DX Spot:', spot.dx_call, 'on', spot.frequency / 1000, 'kHz by', spot.spotter);
    this.render();
};

DXCluster.prototype.addTestSpots = function() {
    // Test data
    this.spots = [
        { frequency: 14230000, dx_call: 'DG7LAN', spotter: 'TEST', time: Date.now(), comment: 'Test spot 1' },
        { frequency: 14300000, dx_call: 'DL8LBY', spotter: 'TEST', time: Date.now(), comment: 'Test spot 2' }
    ];
    this.render();
};

DXCluster.prototype.removeOldSpots = function() {
    var now = Date.now();
    var maxAge = this.maxAge;
    this.spots = this.spots.filter(function(s) {
        return (now - s.time) < maxAge;
    });
};

DXCluster.prototype.getSpotsInRange = function(startFreq, endFreq) {
    return this.spots.filter(function(s) {
        return s.frequency >= startFreq && s.frequency <= endFreq;
    });
};

DXCluster.prototype.render = function() {
    if (typeof bookmarks === 'undefined' || !bookmarks) return;
    if (typeof center_freq === 'undefined' || typeof bandwidth === 'undefined') return;
    
    var bwh = bandwidth / 2;
    var start = center_freq - bwh;
    var end = center_freq + bwh;
    
    this.removeOldSpots();
    
    var visibleSpots = this.getSpotsInRange(start, end);
    
    // Convert to bookmark format
    var dxBookmarks = visibleSpots.map(function(s) {
        var age = (Date.now() - s.time) / 60000; // age in minutes
        // Below 10 MHz use LSB, above use USB (ham convention)
        var mode = s.frequency < 10000000 ? 'lsb' : 'usb';
        return {
            name: s.dx_call,
            frequency: s.frequency,
            modulation: mode,
            description: (s.comment || '') + ' (by ' + s.spotter + ', ' + Math.round(age) + 'm ago)',
            source: 'dxcluster',
            editable: false
        };
    });
    
    bookmarks.replace_bookmarks(dxBookmarks, 'dxcluster', false);
};

DXCluster.prototype.clear = function() {
    this.spots = [];
    this.render();
};

// Initialize when ready
var dxCluster;
$(function() {
    setTimeout(function() {
        dxCluster = new DXCluster();
        
        // Re-render periodically
        setInterval(function() {
            if (dxCluster) dxCluster.render();
        }, 30000);
        
        console.log('DX Cluster initialized');
    }, 1000);
});
