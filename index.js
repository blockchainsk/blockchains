'use strict';
/*******************************************************************************
 * Copyright (c) 2016 blockchains.kr
 * All rights reserved.
 *******************************************************************************/
 
var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');
var async = require('async');
var rest = require(__dirname + '/lib/rest.js');
var helper = require(__dirname + '/lib/helper.js');
var logger = {log: console.log, error: console.error, debug: console.log, warn: console.log};

function ibc(log_outputs) {
    if(log_outputs){
        switch (log_outputs) {
            case log_outputs.info :
                logger.log = log_outputs.info;
                break;
            case log_outputs.error :
                logger.error = log_outputs.error;
                break;
            case log_outputs.warn :
                logger.warn = log_outputs.warn;
                break;
            case log_outputs.debug :
                logger.debug = log_outputs.debug;
                break;
            default:
                logger.log = log_outputs.info;
        }
    }
}
ibc.chaincode = {
    query: {},
    invoke: {},
    deploy: null,
    details:{
        deployed_name: '',
        func: {
            invoke: [],
            query: []
        },
        git_url: '',
        options: {},
        peers: [],
        timestamp: 0,
        users: [],
        unzip_dir: '',
        version: '',
        zip_url: '',
    }
};
ibc.selectedPeer = 0;
ibc.q = [];                                                                            //array of unix timestamps, 1 for each unsettled action
ibc.lastPoll = 0;                                                                    //unix timestamp of the last time we polled
ibc.lastBlock = 0;                                                                    //last blockheight found
var tempDirectory = path.join(__dirname, './temp');                                    //    =./temp - temp directory name


// ============================================================================================================================
// EXTERNAL - load() - wrapper on a standard startup flow.
// 1. load network peer data
// 2. register users with security (if present)
// 3. load chaincode
// ============================================================================================================================
ibc.prototype.load = function(options, cb){
    var errors = [];
    if(!options.network || !options.network.peers) errors.push('the option "network.peers" is required');

    if(errors.length > 0){                                                            //check for input errors
        logger.error('! [fabric-js] Input Error - ibc.load()', errors);
        if(cb) cb(helper.eFmt('load() input error', 400, errors));
        return;                                                                        //get out of dodge
    }

    ibc.chaincode = {                                                                //empty it all
                    query: {
                        read: null
                    },
                    invoke: {},
                    deploy: null,
                    details:{
                                deployed_name: '',
                                func: {
                                    invoke: [],
                                    query: []
                                },
                                git_url: '',
                                options: options.network.options,
                                peers: [],
                                timestamp: 0,
                                users: [],
                                unzip_dir: '',
                                version: '',
                                zip_url: '',
                    }
                };

    // Step 1
    ibc.prototype.network(options.network.peers, options.network.options);

    // Step 2 - optional - only for secure networks
    if(options.network.users){
        options.network.users = options.network.users;
    }
    if(options.network.users && options.network.users.length > 0){
        ibc.chaincode.details.users = options.network.users;
        var arr = [];
        for(var i in ibc.chaincode.details.peers){
            arr.push(i);                                                            //build the list of indexes
        }
        async.each(arr, function(i, a_cb) {
            if(options.network.users[i]){                                            //make sure we still have a enrollID for this network
                var maxRetry = 2;
                if(options.network.options && options.network.options.maxRetry) maxRetry = options.network.options.maxRetry;
                ibc.prototype.register(i, options.network.users[i].enrollId, options.network.users[i].enrollSecret, maxRetry, a_cb);
            }
            else a_cb();
        }, function(err, data){
            if(err && cb) return cb(err);                                            //error already formated
            else load_cc();
        });
    }
    else{
        ibc.chaincode.details.users = [];
        logger.log('[fabric-js] No membership users found after filtering, assuming this is a network w/o membership');
        load_cc();
    }

    // Step 3
    function load_cc(){
        //load chaincode
        ibc.prototype.load_chaincode(options.chaincode, cb);
    }
};

// ============================================================================================================================
// EXTERNAL - load_chaincode() - load the chaincode
// 2. Create Function
//      Create JS invoke functions for golang functions
//      Create JS query functions for golang functions
// 3. Call callback()
// ============================================================================================================================
ibc.prototype.load_chaincode = function(options, cb) {
    var go_funcs = [], cc_suspects = [], cc_invocations = [], cc_queries = [], cc_inits = [];
    var found_query = false, found_invoke = false;

    ibc.chaincode.details.deployed_name = options.deploy_name;
    ibc.chaincode.details.git_url = options.git_url;
    if( options.version ){
        ibc.chaincode.details.version = options.version;
    }
    if( options.invoke.length > 0 ) {
        found_invoke = true;
        ibc.chaincode.details.func.invoke = [];
        for(var i in options.invoke){
            build_invoke_func(options.invoke[i]);
        }

    }

    if( options.query.length > 0 ) {
        found_query = true;
        ibc.chaincode.details.func.query = [];
        for(var i in options.query){                                            //build the rest call for each function
            build_query_func(options.query[i]);
        }
    }
    // Step 3.                                                                    success!
    logger.log('[fabric-js] load_chaincode() finished');
    ibc.chaincode.details.timestamp = Date.now();
    ibc.chaincode.deploy = deploy;
    if(cb) {
        return cb(null, ibc.chaincode);
    }
};

// ============================================================================================================================
// EXTERNAL - network() - setup network configuration to hit a rest peer
// ============================================================================================================================
ibc.prototype.network = function(arrayPeers, options){
    var errors = [];
    ibc.chaincode.details.options = {quiet: true, timeout: 60000, tls: true};            //defaults
    
    if(!arrayPeers || arrayPeers.constructor !== Array) errors.push('network input arg should be array of peer objects');
    
    if(options){
        if(options.quiet === true || options.quiet === false) ibc.chaincode.details.options.quiet = options.quiet;    //optional fields
        if(!isNaN(options.timeout)) ibc.chaincode.details.options.timeout = Number(options.timeout);
        if(options.tls === true || options.tls === false) ibc.chaincode.details.options.tls = options.tls;
    }
    
    for(var i in arrayPeers){                                                            //check for errors in peers input obj
        if(!arrayPeers[i].id)         errors.push('peer ' + i + ' is missing the field id');
        if(!arrayPeers[i].api_host) errors.push('peer ' + i + ' is missing the field api_host');
        if(options && options.tls === false){
            if(!arrayPeers[i].api_port) errors.push('peer ' + i + ' is missing the field api_port');
        }
        else{
            if(!arrayPeers[i].api_port_tls) errors.push('peer ' + i + ' is missing the field api_port_tls');
        }
    }

    if(errors.length > 0){                                                                //check for input errors
        logger.error('! [fabric-js] Input Error - ibc.network()', errors);
    }
    else{
        ibc.chaincode.details.peers = [];
        for(i in arrayPeers){
            var pos = arrayPeers[i].id.indexOf('_') + 1;
            var temp =     {
                            name: arrayPeers[i].id.substring(pos) + '-' + arrayPeers[i].id.substring(0, 12) + '...:' + arrayPeers[i].api_port_tls,
                            api_host: arrayPeers[i].api_host,
                            api_port: arrayPeers[i].api_port,
                            api_port_tls:  arrayPeers[i].api_port_tls,
                            id: arrayPeers[i].id,
                            tls: ibc.chaincode.details.options.tls
                        };
            if(options && options.tls === false){                                        //if not tls rebuild a few things
                temp.name = arrayPeers[i].id.substring(pos) + '-' + arrayPeers[i].id.substring(0, 12) + '...:' + arrayPeers[i].api_port;
            }
    
            logger.log('[fabric-js] Peer: ', temp.name);                                    //print the friendly name
            ibc.chaincode.details.peers.push(temp);
        }

        rest.init({                                                                        //load default values for rest call to peer
                    host: ibc.chaincode.details.peers[0].api_host,
                    port: pick_port(0),
                    headers: {
                                'Content-Type': 'application/json',
                                'Accept': 'application/json',
                            },
                    ssl: ibc.chaincode.details.peers[0].tls,
                    timeout: ibc.chaincode.details.options.timeout,
                    quiet: ibc.chaincode.details.options.quiet
        }, logger);
    }
};

//pick tls or non-tls port based on the tls setting
function pick_port(pos){
    var port = ibc.chaincode.details.peers[pos].api_port_tls;
    if(ibc.chaincode.details.peers[pos].tls === false) port = ibc.chaincode.details.peers[pos].api_port;
    return port;
}


// ============================================================================================================================
// EXTERNAL - switchPeer() - switch the default peer to hit
// ============================================================================================================================
ibc.prototype.switchPeer = function(index) {
    if(ibc.chaincode.details.peers[index]) {
        rest.init({                                                                        //load default values for rest call to peer
                    host: ibc.chaincode.details.peers[index].api_host,
                    port: pick_port(index),
                    headers: {
                                'Content-Type': 'application/json',
                                'Accept': 'application/json',
                            },
                    ssl: ibc.chaincode.details.peers[index].tls,
                    timeout: ibc.chaincode.details.options.timeout,
                    quiet: ibc.chaincode.details.options.quiet
        });
        ibc.selectedPeer = index;
        return true;
    } else {
        return false;
    }
};

// ============================================================================================================================
// EXTERNAL - save() - write chaincode details to a json file
// ============================================================================================================================
ibc.prototype.save =  function(dir, cb){
    var errors = [];
    if(!dir) errors.push('the option "dir" is required');
    if(errors.length > 0){                                                                //check for input errors
        logger.error('[fabric-js] Input Error - ibc.save()', errors);
        if(cb) cb(helper.eFmt('save() input error', 400, errors));
    }
    else{
        var fn = 'chaincode.json';                                                        //default name
        if(ibc.chaincode.details.deployed_name) fn = ibc.chaincode.details.deployed_name + '.json';
        var dest = path.join(dir, fn);
        fs.writeFile(dest, JSON.stringify({details: ibc.chaincode.details}), function(e){
            if(e != null){
                logger.error('[fabric-js] ibc.save() error', e);
                if(cb) cb(helper.eFmt('save() fs write error', 500, e), null);
            }
            else {
                if(cb) cb(null, null);
            }
        });
    }
};

// ============================================================================================================================
// EXTERNAL - clear() - clear the temp directory
// ============================================================================================================================
ibc.prototype.clear =  function(cb){
    logger.log('[fabric-js] removing temp dir');
    helper.removeThing(tempDirectory, cb);                                            //remove everything in this directory
};

//============================================================================================================================
// EXTERNAL chain_stats() - get blockchain stats
//============================================================================================================================
ibc.prototype.chain_stats =  function(cb){
    var options = {path: '/chain'};                                                    //very simple API, get chainstats!

    options.success = function(statusCode, data){
        logger.log('[fabric-js] Chain Stats - success');
        if(cb) cb(null, data);
    };
    options.failure = function(statusCode, e){
        logger.error('[fabric-js] Chain Stats - failure:', statusCode, e);
        if(cb) cb(helper.eFmt('chain_stats() error', statusCode, e), null);
    };
    rest.get(options, '');
};

//============================================================================================================================
// EXTERNAL block_stats() - get block meta data
//============================================================================================================================
ibc.prototype.block_stats =  function(id, cb){
    var options = {path: '/chain/blocks/' + id};                                    //i think block IDs start at 0, height starts at 1, fyi
    options.success = function(statusCode, data){
        logger.log('[fabric-js] Block Stats - success');
        if(cb) cb(null, data);
    };
    options.failure = function(statusCode, e){
        logger.error('[fabric-js] Block Stats - failure:', statusCode);
        if(cb) cb(helper.eFmt('block_stats() error', statusCode, e), null);
    };
    rest.get(options, '');
};

//============================================================================================================================
// EXTERNAL - register() - register a enrollId with a peer (only for a blockchain network with membership)
//============================================================================================================================
ibc.prototype.register = function(index, enrollID, enrollSecret, maxRetry, cb) {
    register(index, enrollID, enrollSecret, maxRetry, 1, cb);
};

function register(index, enrollID, enrollSecret, maxRetry, attempt, cb){
    logger.log('[fabric-js] Registering ', ibc.chaincode.details.peers[index].name, ' w/enrollID - ' + enrollID);
    var options = {
        path: '/registrar',
        host: ibc.chaincode.details.peers[index].api_host,
        port: pick_port(index),
        ssl: ibc.chaincode.details.peers[index].tls
    };

    var body =     {
                    enrollId: enrollID,
                    enrollSecret: enrollSecret
                };

    options.success = function(statusCode, data){
        logger.log('[fabric-js] Registration success x' + attempt + ' :', enrollID);
        ibc.chaincode.details.peers[index].enrollID = enrollID;                            //remember a valid enrollID for this peer
        if(cb) cb(null, data);
    };
    options.failure = function(statusCode, e){
        logger.error('[fabric-js] Register - failure x' + attempt + ' :', enrollID, statusCode);
        if(attempt <= maxRetry){                                                        //lets try again after a short delay, maybe the peer is still starting
            logger.log('[fabric-js] \tgoing to try to register again in 30 secs');
            setTimeout(function(){register(index, enrollID, enrollSecret, maxRetry, ++attempt, cb);}, 30000);
        }
        else{
            if(cb) cb(helper.eFmt('register() error', statusCode, e), null);            //give up
        }
    };
    rest.post(options, '', body);
}

//============================================================================================================================
// EXTERNAL - unregister() - unregister a enrollId from a peer (only for a blockchain network with membership), enrollID can no longer make transactions
//============================================================================================================================
ibc.prototype.unregister = function(index, enrollID, cb) {
    logger.log('[fabric-js] Unregistering ', ibc.chaincode.details.peers[index].name, ' w/enrollID - ' + enrollID);
    var options = {
        path: '/registrar/' + enrollID,
        host: ibc.chaincode.details.peers[index].api_host,
        port: pick_port(index),
        ssl: ibc.chaincode.details.peers[index].tls
    };

    options.success = function(statusCode, data){
        logger.log('[fabric-js] Unregistering success:', enrollID);
        ibc.chaincode.details.peers[index].enrollID = null;                                //unremember a valid enrollID for this peer
        if(cb) cb(null, data);
    };
    options.failure = function(statusCode, e){
        logger.log('[fabric-js] Unregistering - failure:', enrollID, statusCode);
        if(cb) cb(helper.eFmt('unregister() error', statusCode, e), null);
    };
    rest.delete(options, '');
};

//============================================================================================================================
// EXTERNAL - check_register() - check if a enrollID is registered or not with a peer
//============================================================================================================================
ibc.prototype.check_register = function(index, enrollID, cb) {
    logger.log('[fabric-js] Checking ', ibc.chaincode.details.peers[index].name, ' w/enrollID - ' + enrollID);
    var options = {
        path: '/registrar/' + enrollID,
        host: ibc.chaincode.details.peers[index].api_host,
        port: pick_port(index),
        ssl: ibc.chaincode.details.peers[index].tls
    };

    options.success = function(statusCode, data){
        logger.log('[fabric-js] Check Register success:', enrollID);
        if(cb) cb(null, data);
    };
    options.failure = function(statusCode, e){
        logger.error('[fabric-js] Check Register - failure:', enrollID, statusCode);
        if(cb) cb(helper.eFmt('check_register() error', statusCode, e), null);
    };
    rest.get(options, '');
};

//============================================================================================================================
//deploy() - deploy chaincode and call a cc function
//============================================================================================================================
function deploy(func, args, deploy_options, enrollId, cb){
    if(typeof enrollId === 'function'){                                             //if cb is in 2nd param use known enrollId
        cb = enrollId;
        enrollId = ibc.chaincode.details.peers[ibc.selectedPeer].enrollID;
    }
    if(enrollId == null) {                                                            //if enrollId not provided, use known valid one
        enrollId = ibc.chaincode.details.peers[ibc.selectedPeer].enrollID;
    }

    logger.log('[fabric-js] Deploy Chaincode - Starting');
    logger.log('[fabric-js] \tfunction:', func, ', arg:', args);
    logger.log('\n\n\t Waiting...');                                                //this can take awhile
    
    var options = {}, body = {};
    options = {path: '/chaincode'};
    body =     {
                jsonrpc: '2.0',
                method: 'deploy',
                params: {
                    type: 1,
                    chaincodeID:{
                        path: ibc.chaincode.details.git_url
                    },
                    ctorMsg: {
                        function: func,
                        args: args
                    },
                    secureContext: enrollId
                },
                id: Date.now()
            };


    // ---- Success ---- //
    options.success = function(statusCode, data){
        ibc.chaincode.details.deployed_name = data.result.message;
        //if(ibc.chaincode.details.deployed_name.length < 32) ibc.chaincode.details.deployed_name = '';            //doesnt look right, let code below catch error

        if(ibc.chaincode.details.deployed_name === ''){
            logger.error('\n\n\t deploy resp error - there is no chaincode hash name in response:', data);
            if(cb) cb(helper.eFmt('deploy() error no cc name', 502, data), null);
        }
        else{
            ibc.prototype.save(tempDirectory);                                        //save it to known place so we remember the cc name
            if(deploy_options && deploy_options.save_path != null) {                //save it to custom route
                ibc.prototype.save(deploy_options.save_path);
            }
            
            if(cb){
                var wait_ms = 500;                                                //default wait after deploy, peer may still be starting
                if(deploy_options && deploy_options.delay_ms && Number(deploy_options.delay_ms)) wait_ms = deploy_options.delay_ms;
                logger.log('\n\n\t deploy success [waiting another', (wait_ms / 1000) ,'seconds]');
                logger.log('\t', ibc.chaincode.details.deployed_name, '\n');
                
                setTimeout(function(){
                    logger.log('[fabric-js] Deploy Chaincode - Complete');
                    cb(null, data);
                }, wait_ms);                                                        //wait extra long, not always ready yet
            }
        }
    };
    
    // ---- Failure ---- ///
    options.failure = function(statusCode, e){
        logger.error('[fabric-js] deploy - failure:', statusCode);
        if(cb) cb(helper.eFmt('deploy() error', statusCode, e), null);
    };
    rest.post(options, '', body);
}

//============================================================================================================================
//heart_beat() - interval function to poll against blockchain height (has fast and slow mode)
//============================================================================================================================
var slow_mode = 10000;
var fast_mode = 500;
function heart_beat(){
    if(ibc.lastPoll + slow_mode < Date.now()){                                    //slow mode poll
        //logger.log('[fabric-js] Its been awhile, time to poll');
        ibc.lastPoll = Date.now();
        ibc.prototype.chain_stats(cb_got_stats);
    }
    else{
        for(var i in ibc.q){
            var elasped = Date.now() - ibc.q[i];
            if(elasped <= 3000){                                                //fresh unresolved action, fast mode!
                logger.log('[fabric-js] Unresolved action, must poll');
                ibc.lastPoll = Date.now();
                ibc.prototype.chain_stats(cb_got_stats);
            }
            else{
                //logger.log('[fabric-js] Expired, removing');
                ibc.q.pop();                                                    //expired action, remove it
            }
        }
    }
}

function cb_got_stats(e, stats){
    if(e == null){
        if(stats && stats.height){
            if(ibc.lastBlock != stats.height) {                                    //this is a new block!
                logger.log('[fabric-js] New block!', stats.height);
                ibc.lastBlock  = stats.height;
                ibc.q.pop();                                                    //action is resolved, remove
                if(ibc.monitorFunction) ibc.monitorFunction(stats);                //call the user's callback
            }
        }
    }
}

//============================================================================================================================
// EXTERNAL- monitor_blockheight() - exposed function that user can use to get callback when any new block is written to the chain
//============================================================================================================================
ibc.prototype.monitor_blockheight = function(cb) {                                //hook in your own function, triggers when chain grows
    setInterval(function(){heart_beat();}, fast_mode);
    ibc.monitorFunction = cb;                                                    //store it
};

//============================================================================================================================
// EXTERNAL- get_transaction() - exposed function to find a transaction based on its UDID
//============================================================================================================================
ibc.prototype.get_transaction = function(udid, cb) {
    var options = {
        path: '/transactions/' + udid
    };

    options.success = function(statusCode, data){
        logger.log('[fabric-js] Get Transaction - success:', data);
        if(cb) cb(null, data);
    };
    options.failure = function(statusCode, e){
        logger.error('[fabric-js] Get Transaction - failure:', statusCode);
        if(cb) cb(helper.eFmt('read() error', statusCode, e), null);
    };
    rest.get(options, '');
};

//============================================================================================================================
//                                                    Helper Functions() 
//============================================================================================================================
//build_invoke_func() - create JS function that calls the custom goLang function in the chaincode
//==================================================================
function build_invoke_func(name){
    if(ibc.chaincode.invoke[name] != null){                                            //skip if already exists
        logger.log('[fabric-js] \t skip, func', name, 'already exists');
    }
    else {
        logger.log('[fabric-js] Found cc invoke function: ', name);
        ibc.chaincode.details.func.invoke.push(name);
        ibc.chaincode.invoke[name] = function(args, enrollId, cb){                    //create the function in the chaincode obj
            if(typeof enrollId === 'function'){                                     //if cb is in 2nd param use known enrollId
                cb = enrollId;
                enrollId = ibc.chaincode.details.peers[ibc.selectedPeer].enrollID;
            }
            if(enrollId == null) {                                                    //if enrollId not provided, use known valid one
                enrollId = ibc.chaincode.details.peers[ibc.selectedPeer].enrollID;
            }

            var options = {}, body = {};
            //if(ibc.chaincode.details.version.indexOf('hyperledger/fabric/core/chaincode/shim') >= 0){
            options = {path: '/chaincode'};
            body = {
                        jsonrpc: '2.0',
                        method: 'invoke',
                        params: {
                            type: 1,
                            chaincodeID:{
                                name: ibc.chaincode.details.deployed_name
                            },
                            ctorMsg: {
                                function: name,
                                args: args
                            },
                            secureContext: enrollId
                        },
                        id: Date.now()
                    };

            
            options.success = function(statusCode, data){
                // logger.log('[fabric-js]', name, ' - success:', data);
                ibc.q.push(Date.now());                                                //new action, add it to queue
                if(cb) cb(null, data);
            };
            options.failure = function(statusCode, e){
                logger.error('[fabric-js]', name, ' - failure:', statusCode, e);
                if(cb) cb(helper.eFmt('invoke() error', statusCode, e), null);
            };
            rest.post(options, '', body);
        };
    }
}

//==================================================================
//build_query_func() - create JS function that calls the custom goLang function in the chaincode
//==================================================================
function build_query_func(name){
    if(ibc.chaincode.query[name] == null || name === 'read'){       // Check Exist
        logger.log('[fabric-js] Found cc query function: ', name);
        ibc.chaincode.details.func.query.push(name);
        ibc.chaincode.query[name] = function(args, enrollId, cb){                    //create the function in the chaincode obj
            if(typeof enrollId === 'function'){                                     //if cb is in 2nd param use known enrollId
                cb = enrollId;
                enrollId = ibc.chaincode.details.peers[ibc.selectedPeer].enrollID;
            }
            if(enrollId == null) {                                                    //if enrollId not provided, use known valid one
                enrollId = ibc.chaincode.details.peers[ibc.selectedPeer].enrollID;
            }
            
            var options = {}, body = {};

            options = {path: '/chaincode'};
            body = {
                        jsonrpc: '2.0',
                        method: 'query',
                        params: {
                            type: 1,
                            chaincodeID:{
                                name: ibc.chaincode.details.deployed_name
                            },
                            ctorMsg: {
                                function: name,
                                args: args
                            },
                            secureContext: enrollId
                        },
                        id: Date.now()
                    };


            
            options.success = function(statusCode, data){
                //logger.log('[fabric-js]', name, ' - success:', data);
                if(cb){
                    if(data){
                        if(data.result) cb(null, data.result.message);
                        else cb(null, data.OK);
                    }
                    else cb(helper.eFmt('query() resp error', 502, data), null);        //something is wrong, response is not what we expect
                }
            };
            options.failure = function(statusCode, e){
                logger.error('[fabric-js]', name, ' - failure:', statusCode, e);
                if(cb) cb(helper.eFmt('query() error', statusCode, e), null);
            };
            rest.post(options, '', body);
        };
    }
}

module.exports = ibc;
