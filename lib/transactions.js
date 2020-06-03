'use strict';

var bitcore = require('ghost-bitcore-lib');
var _ = bitcore.deps._;
var $ = bitcore.util.preconditions;
var BufferUtil = bitcore.util.buffer;
var Common = require('./common');
var async = require('async');


var MAXINT = 0xffffffff; // Math.pow(2, 32) - 1;

function TxController(node) {
  this.node = node;
  this.common = new Common({log: this.node.log});
}

TxController.prototype.show = function(req, res) {
  if (req.transaction) {
    res.jsonp(req.transaction);
  }
};

/**
 * Find transaction by hash ...
 */
TxController.prototype.transaction = function(req, res, next) {
  var self = this;
  var txid = req.params.txid;

  this.node.getDetailedTransaction(txid, function(err, transaction) {
    if (err && err.code === -5) {
      return self.common.handleErrors(null, res);
    } else if(err) {
      return self.common.handleErrors(err, res);
    }

    self.transformTransaction(transaction, function(err, transformedTransaction) {
      if (err) {
        return self.common.handleErrors(err, res);
      }
      req.transaction = transformedTransaction;
      next();
    });

  });
};

TxController.prototype.transformTransaction = function(transaction, options, callback) {
  if (_.isFunction(options)) {
    callback = options;
    options = {};
  }
  $.checkArgument(_.isFunction(callback));

  var confirmations = 0;

  if(transaction.height >= 0) {
    confirmations = this.node.services.bitcoind.height - transaction.height + 1;
  }

  var transformed = {
    txid: transaction.hash,
    version: transaction.version,
    locktime: transaction.locktime
  };

  if (((transaction.version >> 8) & 0xFF) == 2)
    transformed.isCoinStake = true;

  if(transaction.coinbase) {
    transformed.vin = [
      {
        coinbase: transaction.inputs[0].script,
        sequence: transaction.inputs[0].sequence,
        n: 0
      }
    ];
  } else {
    transformed.vin = transaction.inputs.map(this.transformInput.bind(this, options));
  }

  options.isCoinStake = transformed.isCoinStake
  transformed.vout = transaction.outputs.map(this.transformOutput.bind(this, options));

  transformed.blockhash = transaction.blockHash;
  transformed.blockheight = transaction.height;
  transformed.confirmations = confirmations;
  // TODO consider mempool txs with receivedTime?
  var time = transaction.blockTimestamp ? transaction.blockTimestamp : Math.round(Date.now() / 1000);
  transformed.time = time;
  if (transformed.confirmations) {
    transformed.blocktime = transformed.time;
  }

  if(transaction.coinbase) {
    transformed.isCoinBase = true;
  }

  transformed.valueOut = transaction.outputSatoshis / 1e8;
  transformed.size = transaction.hex.length / 2; // in bytes
  if (!transaction.coinbase) {
    transformed.valueIn = transaction.inputSatoshis / 1e8;

    if (_.isUndefined(options.feeSatoshis))
      transformed.fees = transaction.feeSatoshis / 1e8;
    else
      transformed.fees = options.feeSatoshis / 1e8;
  }

  callback(null, transformed);
};

TxController.prototype.transformInput = function(options, input, index) {
  // Input scripts are validated and can be assumed to be valid
  var transformed = {
    txid: input.prevTxId,
    vout: input.outputIndex,
    sequence: input.sequence,
    n: index
  };

  if (!options.noScriptSig) {
    transformed.scriptSig = {
      hex: input.script
    };
    if (!options.noAsm) {
      transformed.scriptSig.asm = input.scriptAsm;
    }

    transformed.witnessStack = input.witnessStack;
  }


  transformed.type = input.type;
  transformed.addr = input.address;
  transformed.valueSat = input.satoshis;
  transformed.value = input.satoshis / 1e8;
  transformed.doubleSpentTxID = null; // TODO
  //transformed.isConfirmed = null; // TODO
  //transformed.confirmations = null; // TODO
  //transformed.unconfirmedInput = null; // TODO

  if (transformed.type == 'anon') {
    transformed.num_inputs = input.num_inputs;
    transformed.ring_size = input.ring_size;
  }
  return transformed;
};

function getVarIntAsFloat(offset, data_bytes)
{
  var fl = 0.0;
  var i;
  for (i = 0; i < 10; ++i) {
    var b = data_bytes[offset++];
    //rv += (b & 0x7F) << (7*i);
    fl += (b & 0x7F) * Math.pow(2.0, 7*i)
    if (!(b & 0x80) || offset >= data_bytes.length) {
      break
    }
  }
  return [fl, i];
}

TxController.prototype.transformOutput = function(options, output, index) {
  var transformed = {
    value: (output.satoshis / 1e8).toFixed(8),
    n: index,
    scriptPubKey: {
      hex: output.script
    }
  };

  transformed.type = output.type;

  if (!options.noAsm) {
    transformed.scriptPubKey.asm = output.scriptAsm;
  }

  if (!options.noSpent) {
    transformed.spentTxId = output.spentTxId || null;
    transformed.spentIndex = _.isUndefined(output.spentIndex) ? null : output.spentIndex;
    transformed.spentHeight = output.spentHeight || null;
  }

  if (output.address) {
    transformed.scriptPubKey.addresses = [output.address];
    var address = bitcore.Address(output.address); //TODO return type from bitcore-node
    transformed.scriptPubKey.type = address.type;
  }

  if (output.type == 'blind' || output.type == 'anon')
  {
    transformed.valueCommitment = output.valueCommitment;

    transformed.rp_exponent = output.rp_exponent;
    transformed.rp_mantissa = output.rp_mantissa;
    transformed.rp_min_value = output.rp_min_value;
    transformed.rp_max_value = output.rp_max_value;
    transformed.rp_size = output.rp_size;
  }

  if (output.data) {
    transformed.data = output.data;
    transformed.v = []

    var data_bytes = BufferUtil.hexToBuffer(output.data);
    var offset = 0;
    if (options.isCoinStake) {
      if (data_bytes.length >= 4) {
        var height = 0;
        for (var i = 3; i >= 0; i--) {
          height = (height << 8) + data_bytes[i];
        }
        transformed.v.push({name:"height",value:height});
        offset+=4;
      }
    }
    while(offset < data_bytes.length) {
      var type = data_bytes[offset];
      offset++;
      if (type == 5) { // VOTE
        if (offset + 4 > data_bytes.length) {
          transformed.v.push({name:"error",value:type});
          break;
        }
        var vote = 0;
        for (var i = offset+3; i >= offset; i--) {
          vote = (vote << 8) + data_bytes[i];
        }
        offset+=4;
        var strvote = "proposal " + (vote & 0xFFFF) + ", option " + (vote >> 16);
        transformed.v.push({name:"vote",value:strvote});
      } else
      if (type == 6) { // FEE
        if (offset + 1 > data_bytes.length) {
          transformed.v.push({name:"error",value:type});
          break;
        }
        var vi = getVarIntAsFloat(offset, data_bytes);
        var fee = vi[0];
        offset += vi[1]+1;
        options.feeSatoshis = fee;
        fee /= 1e8;
        transformed.v.push({name:"fee",value:fee});
      } else
      if (type == 7) { // DEV_FUND_CFWD
        if (offset + 1 > data_bytes.length) {
          transformed.v.push({name:"error",value:type});
          break;
        }
        var vi = getVarIntAsFloat(offset, data_bytes);
        var cfwd = vi[0];
        offset += vi[1]+1;
        cfwd /= 1e8;
        transformed.v.push({name:"foundation-fund",value:cfwd});
      } else
      if (type == 9) { // DO_SMSG_FEE
        if (offset + 1 > data_bytes.length) {
          transformed.v.push({name:"error",value:type});
          break;
        }
        var vi = getVarIntAsFloat(offset, data_bytes);
        var value = vi[0];
        offset += vi[1]+1;
        value /= 1e8;
        transformed.v.push({name:"smsg-fee-rate",value:value});
      } else
      if (type == 10) { // DO_SMSG_DIFFICULTY
        if (offset + 1 > data_bytes.length) {
          transformed.v.push({name:"error",value:type});
          break;
        }
        var vi = getVarIntAsFloat(offset, data_bytes);
        var value = vi[0];
        offset += vi[1]+1;
        transformed.v.push({name:"smsg-difficulty",value:Math.round(value).toString(16)});
      } else {
        transformed.v.push({name:"unknown",value:type});
        break;
      }
    }
  }

  return transformed;
};

TxController.prototype.transformInvTransaction = function(transaction) {
  var self = this;

  var valueOut = 0;
  var vout = [];
  for (var i = 0; i < transaction.outputs.length; i++) {
    var output = transaction.outputs[i];
    valueOut += output.satoshis;
    if (output.script) {
      var address = output.script.toAddress(self.node.network);
      if (address) {
        var obj = {};
        obj[address.toString()] = output.satoshis;
        vout.push(obj);
      }
    }
  }

  var isRBF = _.some(_.map(transaction.inputs, 'sequenceNumber'), function(seq) {
    return seq < MAXINT - 1;
  });

  var transformed = {
    txid: transaction.hash,
    valueOut: valueOut / 1e8,
    vout: vout,
    isRBF: isRBF,
  };

  return transformed;
};

TxController.prototype.rawTransaction = function(req, res, next) {
  var self = this;
  var txid = req.params.txid;

  this.node.getTransaction(txid, function(err, transaction) {
    if (err && err.code === -5) {
      return self.common.handleErrors(null, res);
    } else if(err) {
      return self.common.handleErrors(err, res);
    }

    req.rawTransaction = {
      'rawtx': transaction.toBuffer().toString('hex')
    };

    next();
  });
};

TxController.prototype.showRaw = function(req, res) {
  if (req.rawTransaction) {
    res.jsonp(req.rawTransaction);
  }
};

TxController.prototype.list = function(req, res) {
  var self = this;

  var blockHash = req.query.block;
  var address = req.query.address;
  var page = parseInt(req.query.pageNum) || 0;
  var pageLength = 10;
  var pagesTotal = 1;

  if(blockHash) {
    self.node.getBlockOverview(blockHash, function(err, block) {
      if(err && err.code === -5) {
        return self.common.handleErrors(null, res);
      } else if(err) {
        return self.common.handleErrors(err, res);
      }

      var totalTxs = block.txids.length;
      var txids;

      if(!_.isUndefined(page)) {
        var start = page * pageLength;
        txids = block.txids.slice(start, start + pageLength);
        pagesTotal = Math.ceil(totalTxs / pageLength);
      } else {
        txids = block.txids;
      }

      async.mapSeries(txids, function(txid, next) {
        self.node.getDetailedTransaction(txid, function(err, transaction) {
          if (err) {
            return next(err);
          }
          self.transformTransaction(transaction, next);
        });
      }, function(err, transformed) {
        if(err) {
          return self.common.handleErrors(err, res);
        }

        res.jsonp({
          pagesTotal: pagesTotal,
          txs: transformed
        });
      });

    });
  } else if(address) {
    var options = {
      from: page * pageLength,
      to: (page + 1) * pageLength
    };

    self.node.getAddressHistory(address, options, function(err, result) {
      if(err) {
        return self.common.handleErrors(err, res);
      }

      var txs = result.items.map(function(info) {
        return info.tx;
      }).filter(function(value, index, self) {
        return self.indexOf(value) === index;
      });

      async.map(
        txs,
        function(tx, next) {
          self.transformTransaction(tx, next);
        },
        function(err, transformed) {
          if (err) {
            return self.common.handleErrors(err, res);
          }
          res.jsonp({
            pagesTotal: Math.ceil(result.totalCount / pageLength),
            txs: transformed
          });
        }
      );
    });
  } else {
    return self.common.handleErrors(new Error('Block hash or address expected'), res);
  }
};

TxController.prototype.send = function(req, res) {
  var self = this;
  this.node.sendTransaction(req.body.rawtx, function(err, txid) {
    if(err) {
      // TODO handle specific errors
      return self.common.handleErrors(err, res);
    }

    res.json({'txid': txid});
  });
};

module.exports = TxController;
