#!/usr/bin/env node

var change = require('percent-change')
var numeral = require('numeral');
var moment = require("moment");
var request = require("request-promise");
var blessed = require('blessed')
var contrib = require('blessed-contrib')
var chalk = require('chalk');
var RateLimiter = require('limiter').RateLimiter;
var ConfigParser = require('configparser');
var config = new ConfigParser();
var WebSocket = require('ws');
var ReconnectingWebSocket = require('reconnecting-websocket');

config.read('config.ini');

var rws     = new ReconnectingWebSocket('wss://ws-feed.pro.coinbase.com', [], {constructor: WebSocket});
var pairs   = config.sections();
var limiter = new RateLimiter(3, 'second');
var screen  = blessed.screen()

screen.key(['escape', 'q', 'C-c'], function(ch, key) {
  // Close WebSocket
  rws.close();

  // Kill process.
  return process.exit(0);
});

var initialState = {candles: {x: [], y: []}, rate: 0, average: 0, high: 0, low: 0, change: {5: 0, 30: 0, 60: 0, 720: 0, 1440: 0}, ath: 0}
var state = [Object.assign({}, initialState, {pair: pairs[0]}), Object.assign({}, initialState, {pair: pairs[1]}), Object.assign({}, initialState, {pair: pairs[2]})];

var grid = new contrib.grid({rows: 12, cols: 2, screen: screen})

var lineConfig = {showLegend: false, label: '', style: {line: "yellow", text: "green", baseline: "black"}, xLabelPadding: 0, xPadding: 0, numYLabels: 11}

var lineCharts = [
  grid.set(0, 0, 6, 1, contrib.line, Object.assign({}, lineConfig, {label: pairs[0] + ' (GDAX ' + config.get(pairs[0], 'granularity') + ' ' + config.get(pairs[0], 'dataPoint') + ')', style: {line: config.get(pairs[0], 'lineColor'), text: "green", baseline: "black"}})),
  grid.set(0, 1, 6, 1, contrib.line, Object.assign({}, lineConfig, {label: pairs[1] + ' (GDAX ' + config.get(pairs[1], 'granularity') + ' ' + config.get(pairs[1], 'dataPoint') + ')', style: {line: config.get(pairs[1], 'lineColor'), text: "green", baseline: "black"}})),
  grid.set(6, 0, 6, 1, contrib.line, Object.assign({}, lineConfig, {label: pairs[2] + ' (GDAX ' + config.get(pairs[2], 'granularity') + ' ' + config.get(pairs[2], 'dataPoint') + ')', style: {line: config.get(pairs[2], 'lineColor'), text: "green", baseline: "black"}})),
];

var rateTable       = grid.set(6, 1, 2, 1, contrib.table, {label: 'Chart stats', fg: 'white', interactive: false, columnSpacing: 3, columnWidth: [7, 13, 13, 13, 13, 13]});
var percentageTable = grid.set(8, 1, 2, 1, contrib.table, {label: 'Change', fg: 'white', interactive: false, columnSpacing: 3, columnWidth: [7, 13, 13, 13, 13, 13]});
var liveTable       = grid.set(10, 1, 2, 1, contrib.table, {label: 'Live trades & running totals', fg: 'white', interactive: false, columnSpacing: 3, columnWidth: [7, 10, 5, 9, 13, 11, 7, 7]});

// Map array keys to labels for each granularity setting
var granularityMap = {
  '1m':  [[1, ' 1m'], [6, ' 5m'], [16, '15m'], [31, '30m'], [61, ' 1h']],
  '5m':  [[1, ' 5m'], [6, '30m'], [12, ' 1h'], [144, '12h'], [287, ' 1d']],
  '15m': [[1, '15m'], [2, '30m'], [4, ' 1h'], [8, ' 2h'], [16, ' 4h']],
  '1h':  [[1, ' 1h'], [2, ' 2h'], [5, ' 5h'], [12, '12h'], [24, ' 1d']],
  '6h':  [[1, ' 6h'], [2, '12h'], [4, ' 1d'], [8, ' 2d'], [16, ' 4d']],
  '1d':  [[1, ' 1d'], [2, ' 2d'], [7, ' 1w'], [14, ' 2w'], [28, ' 1m']],
}

var websocketData = {}

for (var i = 0; i < pairs.length; i++) {
  websocketData[pairs[i]] = {price: 0, side: 'none', size: 0, bought: 0, sold: 0, buy_counter: 0, sell_counter: 0 }
}

// Query API for candle data
var updateCandles = (pair, granularity = 300) => {
  switch (config.get(pair, 'granularity')) {
    case '1m':
      granularity = 60;
      break;
    case '15m':
      granularity = 900;
      break;
    case '1h':
      granularity = 3600;
      break;
    case '6h':
      granularity = 21600;
      break;
    case '1d':
      granularity = 86400;
      break;
    default: // default to case '5m'
      granularity = 300;
  }

  var options = {
    url: 'http://api.pro.coinbase.com/products/' + pair + '/candles?granularity=' + granularity,
    headers: {
      'User-Agent': 'cli-graph-lib'
    },
    json: true

  };

  limiter.removeTokens(1, function() {
    request(options)
      .then((body) => {
        updateValues(pair, body);
      }).catch(function (err) {
        // Whooops, retry next interval ;)
      });
  });
}

// Populate state variables with API returned values
var updateValues = (pair, data) => {
  var candles = {x: [], y: []};

  for (var i = 0; i < data.length; i++) {
    // Keys of response data:
    // 0 time   - bucket start time
    // 1 low    - lowest price during the bucket interval
    // 2 high   - highest price during the bucket interval
    // 3 open   - opening price (first trade) in the bucket interval
    // 4 close  - closing price (last trade) in the bucket interval
    // 5 volume - volume of trading activity during the bucket interval

    var key;

    switch (config.get(pair, 'dataPoint')) {
        case 'low':
          candles.y.push(data[i][1]);
          break;
        case 'high':
          candles.y.push(data[i][2]);
          break;
        case 'open':
          candles.y.push(data[i][3]);
          break;
        case 'average':
          candles.y.push((data[i][1] + data[i][2] + data[i][3] + data[i][4]) / 4);
          break;
        default: // case 'close'
          candles.y.push(data[i][4]);
    }

    var granularity = config.get(pair, 'granularity')
    var format = 'MMM D'; // Used for 6h and 1d

    if (['1m', '5m', '15m'].indexOf(granularity) != -1) {
      var format = 'HH:mm';
    } else if (granularity == '1h') {
      var format = 'MMM D HH:mm';
    }

    candles.x.push(moment.unix(data[i][0]).utc().format(format));
  }

  var key = pairs.indexOf(pair);

  state[key].candles = candles;
  state[key].rate    = state[key].candles.y[0];
  state[key].average = state[key].candles.y.reduce(function(a, b) { return a + b; }) / state[key].candles.y.length;
  state[key].high    = Math.max.apply(Math, state[key].candles.y);
  state[key].low     = Math.min.apply(Math, state[key].candles.y);

  // :TODO: Look into fetching more recent data from ticker api
  state[key].change = getChange(pair, state[key].candles.y);

  // Reverse candles, so old values come first (for chart rendering)
  state[key].candles.x.reverse();
  state[key].candles.y.reverse();
}

// Rendering, called from interval
var render = () => {
  var rateData = [];
  var percentageData = [];
  var liveData = [];

  // Draw line charts
  for (var i = 0; i < pairs.length; i++) {
    // Copy candles to new object, so we can separate the chart view data from the calculations data
    var viewSlice = {x: state[i].candles.x.slice(-60), y: state[i].candles.y.slice(-60)}

    if (viewSlice.x.length == 0) {
      continue;
    }
    var reducer = (accumulator, currentValue) => accumulator + currentValue;
    var high = Math.max.apply(Math, viewSlice.y);
    var low  = Math.min.apply(Math, viewSlice.y);
    var average = parseFloat(viewSlice.y.reduce(reducer)) / viewSlice.y.length;

    // Recalculate line chart zoom
    var padding = (high - low) * 0.03;
    lineCharts[i].options.minY = low - padding;
    lineCharts[i].options.maxY = high + padding;

    // Initialize data for line chart
    var lineData = [viewSlice];

    // Draw optional average line
    if (config.get(state[i].pair, 'drawAverage') == 'true') {
      lineData.unshift({title: 'average in timeframe', x: viewSlice.x, y: new Array(viewSlice.y.length).fill(average), style: {line: [100, 100, 100]}})
    }

    // Populate line chart with data
    lineCharts[i].setData(lineData)

    // Code below is for rendering tables
    var prefix = (config.get(state[i].pair, 'fiat') == 'true') ? '$' : '';
    var format = (config.get(state[i].pair, 'fiat') == 'true') ? '0,0.00' : '0.0000';

    // Data for rate table
    rateData[i] = [
      chalk.bold(state[i].pair),
      prefix + numeral(state[i].rate).format(format),
      prefix + numeral(low).format(format),
      prefix + numeral(high).format(format),
      prefix + numeral(average).format(format),
      formatPercentage(change(average, state[i].rate, true)),
    ];

    // Data for percentage table
    if (state[i].change.length > 0) {
      var granularity = config.get(state[i].pair, 'granularity')

      percentageData[i] = [
        chalk.bold(state[i].pair),
        granularityMap[granularity][0][1] + ':' + state[i].change[0],
        granularityMap[granularity][1][1] + ':' + state[i].change[1],
        granularityMap[granularity][2][1] + ':' + state[i].change[2],
        granularityMap[granularity][3][1] + ':' + state[i].change[3],
        granularityMap[granularity][4][1] + ':' + state[i].change[4],
      ];
    }

    // Data for live table
    if (websocketData[state[i].pair].price != 0) {
      var current = prefix + numeral(websocketData[state[i].pair].price).format(format);
      var side = websocketData[state[i].pair].side;

      if (side == 'sell') {
        current = chalk.red(current);
        side = chalk.red(side);
      } else {
        current = chalk.green(current);
        side = chalk.green(side);
      }

      liveData[i] = [
        chalk.bold(state[i].pair),
        current,
        side,
        numeral(websocketData[state[i].pair].size).format('0.0000'),
        chalk.green(numeral(websocketData[state[i].pair].bought).format('0,0.00')),
        chalk.red(numeral(websocketData[state[i].pair].sold).format('0,0.00')),
        chalk.green(numeral(websocketData[state[i].pair].buy_counter || 0).format('0,0')),
        chalk.red(numeral(websocketData[state[i].pair].sell_counter || 0).format('0,0')),
      ];
    }
  }

  // Populate tables with data
  rateTable.setData({headers: [' pair', ' current', ' low', ' high', ' average', ' % of average'], data: rateData});
  percentageTable.setData({headers: [' pair', '', '', '', '', ''], data: percentageData})
  liveTable.setData({headers: [' pair', ' last', ' side', ' size', ' coins bought', ' coins sold', ' buys', ' sells'], data: liveData})

  // Finally render the whole mess ;)
  screen.render();
}

// Calculate percentage changes of a pair
var getChange = (pair, arr) => {
  var now = arr[0];
  var granularity = config.get(pair, 'granularity');
  var data = [];

  for (var i = 0; i < 5; i++) {
    var item = change(arr[granularityMap[granularity][i][0]], now, true);
    var padding = ((item[0] != '-' && item.length < 6) || (item[0] == '-' && item.length < 7)) ? ' ' : '';
    data.push(padding + formatPercentage(item));
  }

  return data;
}

// Colorize percentage values and prepend + to positive values
var formatPercentage = (num) => {
  return (num[0] != '-') ? chalk.green('+' + num) : chalk.red(num)
}

// Used to call the API for all pairs
var queryApi = () => {
  updateCandles(pairs[0]);
  updateCandles(pairs[1]);
  updateCandles(pairs[2]);
}

// Data fetching main loop, called from interval
var update = () => {
  queryApi();
}

// Subscribe to live data web socket
var subscribeWebSocket = () => {
  var subscription = '{"type": "subscribe", "product_ids": ["' + pairs.join('","') + '"], "channels": ["matches"] }';

  rws.on('open', function open() {
    rws.send(subscription);
  });

  rws.on('message', function incoming(data) {
    data = JSON.parse(data);
    if(data['type'] != 'match') {
      return;
    }

    // The terms 'sell' and 'buy' are switched in the matches channel.
    // Quote from API doc: The side field indicates the maker order side.
    // 'sell' is an uptick and 'buy' a downtick.
    // The variables in this script look at it from the taker's perspective,
    // so a buy is "taker bought coins from maker's sell order", a sell is "taker sold into maker's buy order"

    websocketData[data['product_id']].price = data['price'] || 0;
    websocketData[data['product_id']].side = (data['side'] == 'buy') ? 'sell' : 'buy'; // See comment above.
    websocketData[data['product_id']].size = data['size'] || 0;

    if (data['side'] == 'sell') {
      websocketData[data['product_id']].bought += parseFloat(data['size']) || 0;
      websocketData[data['product_id']].buy_counter++;
    } else if (data['side'] == 'buy') {
      websocketData[data['product_id']].sold += parseFloat(data['size']) || 0;
      websocketData[data['product_id']].sell_counter++;
    }

    // Update line charts latest candle with live data if enabled
    if (config.get(data['product_id'], 'liveChart') == 'true') {
      var pair = pairs.indexOf(data['product_id']);
      state[pair].candles.y[state[pair].candles.y.length - 1] = parseFloat(data['price']);
    }
  });
}

subscribeWebSocket();
update();

// Interval: Render every 150ms
setInterval(render, 150);

// // Interval: update every 30 seconds
setInterval(update, 30000);
