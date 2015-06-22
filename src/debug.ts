
function DebugDisabled() {};

function BuildDebug(typeOrInstance: Object): (message: string, ...args: any[]) => void {
    var typeName = typeof typeOrInstance === 'string' ? typeOrInstance :
        (typeOrInstance.constructor ? typeOrInstance.constructor.name : (<any>typeOrInstance).name);

    if (process.env.DEBUG && (~process.env.DEBUG.indexOf('*') || ~process.env.DEBUG.indexOf('data-beams') || ~process.env.DEBUG.indexOf(typeName))) {
        console.log('Binding debug: ' + process.env.DEBUG + ' - ' + typeName);
        var header = '\t\x1b[36mdata-beams[' + typeName + ']=>\x1b[32m';

        function DebugFunction(message) {
            var args = Array.prototype.slice.call(arguments, 1),
                caller = arguments.callee.caller,
                callerName = caller.name || '',
                outArgs;

            if (callerName === typeName) {
                callerName = '(constructor)';
            } else if (!callerName) {
                while (caller = caller.caller) {
                    callerName = (caller.name || '(anon)') + '->' + callerName;
                    if (caller.name)
                        break;
                }
                callerName += '(anon)';
            }

            // toString needed args
            args = args.map(function(val) {
                switch (typeof val)
                {
                    case 'string':
                    case 'number': {
                        return val;
                    }
                    default: {
                        return (val || '[null]').toString();
                    }
                }
            });

            outArgs = [header + '%s\x1b[39m ' + message, callerName].concat(args);

            console.log.apply(console, outArgs);
        }
        return DebugFunction;
    } else {
        console.log('Not Binding debug: ' + process.env.DEBUG + ' - ' + typeName);
        return DebugDisabled;
    }
}

export = BuildDebug;
