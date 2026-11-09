'use strict';
// The kit owns the one OAP runtime. Only the password gate is public.
const mgu = require('./kit/mgu');
const loader = require('./locked-loader');
const config = require('./locked-config');
mgu.run({ start: function(ctx) { return loader.start(ctx, config); } });
