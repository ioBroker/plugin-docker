const { parseField, walkTheConfig } = require('../build/cjs/lib/templates');

describe('templates', () => {
    describe('substitution', () => {
        const config = { port: 8086, bind: '127.0.0.1', nested: { flag: true } };

        it('should return the raw value when the pattern is the whole field', () => {
            if (parseField('${config.port}', config, { instance: 0 }) !== 8086) {
                throw new Error('A number must not be turned into a string');
            }
            if (parseField('{{config.nested.flag}}', config, { instance: 0 }) !== true) {
                throw new Error('A boolean must not be turned into a string');
            }
        });

        it('should substitute inside a longer string', () => {
            const result = parseField('${config.bind}:${config.port}:8086', config, { instance: 0 });
            if (result !== '127.0.0.1:8086:8086') {
                throw new Error(`Unexpected result: ${result}`);
            }
        });

        it('should use the default when the value is unknown', () => {
            if (parseField('${config.missing:-fallback}', config, { instance: 0 }) !== 'fallback') {
                throw new Error('The default value was not used');
            }
        });

        it('should keep an empty default an empty string, not the number zero', () => {
            // `Number('')` is 0, so an empty default used to reach the container as a literal 0 -
            // a server URL or a plugin list that asked for "nothing" became "0"
            const result = parseField('${config.missing:-}', config, { instance: 0 });
            if (result !== '') {
                throw new Error(`Expected an empty string, got ${JSON.stringify(result)}`);
            }
        });

        it('should still turn a numeric default into a number', () => {
            if (parseField('${config.missing:-8086}', config, { instance: 0 }) !== 8086) {
                throw new Error('A numeric default must stay a number');
            }
            if (parseField('${config.missing:-true}', config, { instance: 0 }) !== true) {
                throw new Error('A boolean default must stay a boolean');
            }
        });
    });

    describe('self-referential values', () => {
        // A value that contains a pattern itself was substituted again and again. The loops run
        // synchronously, so the adapter did not just take long - it never started at all.
        it('should give up instead of looping forever', function () {
            this.timeout(5000);

            let error;
            try {
                parseField('x${config.pass}y', { pass: 'a${config.pass}b' }, { instance: 0 });
            } catch (e) {
                error = e;
            }

            if (!error) {
                throw new Error('A self-referential value must be reported, not silently resolved');
            }
            if (!error.message.includes('substitutions')) {
                throw new Error(`Unexpected error: ${error.message}`);
            }
        });

        it('should also stop for the {{...}} form', function () {
            this.timeout(5000);

            let error;
            try {
                walkTheConfig({ env: { PASS: 'x{{config.pass}}y' } }, { pass: '{{config.pass}}!' }, { instance: 0 });
            } catch (e) {
                error = e;
            }

            if (!error) {
                throw new Error('A self-referential value must be reported, not silently resolved');
            }
        });

        it('should not fire for a value that only looks similar', () => {
            const result = parseField('${config.pass}', { pass: 'a{b}c$d' }, { instance: 0 });
            if (result !== 'a{b}c$d') {
                throw new Error(`A harmless value must pass through unchanged, got ${result}`);
            }
        });
    });
});
