interface AdditionalConfig {
    instance: number;
}

function getAttributeFromObject(instanceConfig: ioBroker.AdapterConfig, attributePath: string): any {
    const parts = attributePath.split('.');
    let current: any = instanceConfig;
    for (const part of parts) {
        if (current && typeof current === 'object' && part in current) {
            current = current[part];
        } else {
            return undefined;
        }
    }
    return current;
}

/** This function get the template, extracts all patterns and replace it with values from instanceConfig */
export function parseField(
    field: string,
    instanceConfig: ioBroker.AdapterConfig,
    additionalConfig: AdditionalConfig,
): any {
    let match: RegExpMatchArray | null;
    // We support 3 types of patterns:
    // - {{config.path.to.value}} and
    // - ${config.path.to.value:-defaultValue} (like in JS template strings). important the name must start with "config."
    // - ${config_path_to_value:-defaultValue} (like in JS template strings)
    // - ${instance} instance number of the adapter

    do {
        match = field.match(/{{(.*?)}}/);
        if (!match) {
            break;
        }
        if (match[1].startsWith('config.')) {
            const pattern = match[1]?.replace(/^config[._]/, ''); // remove "config." or "config_"
            if (!pattern) {
                continue;
            }
            const value = getAttributeFromObject(instanceConfig, pattern);
            if (value !== undefined) {
                // If the value is completely the pattern, return the value as is (could be non-string)
                if (match[0] === field) {
                    return value;
                }
                // Else replace the pattern in the string
                field = field.replace(match[0], String(value));
            } else {
                // If value is not found, replace with empty string
                field = field.replace(match[0], '');
            }
        } else if (additionalConfig[field as keyof AdditionalConfig] !== undefined) {
            // Support also {{instance}} pattern
            const value = additionalConfig[field as keyof AdditionalConfig];
            if (match[0] === field) {
                return value;
            }
            field = field.replace(match[0], String(value));
        } else {
            // Unknown pattern, just remove it
            field = field.replace(match[0], '');
        }
    } while (match);

    do {
        match = field.match(/\$\{(config(?:[._][.a-zA-Z0-9_]+)+)(:-([^}]*))?}/);
        if (!match) {
            break;
        }
        let pattern = match[1];
        const defaultValue = match[3];
        if (pattern.includes('_') && !pattern.includes('.')) {
            // Support also config_path_to_value syntax
            pattern = pattern.replace(/_/g, '.'); // replace "config_" with "config."
        }
        const value = getAttributeFromObject(instanceConfig, pattern.substring(7)); // remove "config."
        if (value !== undefined) {
            // If the value is completely the pattern, return the value as is (could be non-string)
            if (match[0] === field) {
                return value;
            }
            // Else replace the pattern in the string
            field = field.replace(match[0], String(value));
        } else if (defaultValue !== undefined) {
            // If defaultValue is provided, use it
            if (match[0] === field) {
                if (defaultValue === 'true') {
                    return true;
                }
                if (defaultValue === 'false') {
                    return false;
                }
                if (!isNaN(Number(defaultValue))) {
                    return Number(defaultValue);
                }
                return defaultValue;
            }
            field = field.replace(match[0], defaultValue);
        } else {
            // If value is not found, replace with empty string
            field = field.replace(match[0], '');
        }
    } while (match);

    // detect ${instance} or ${instance:-0}
    do {
        match = field.match(/\$\{(\w+)(:-([^}]*))?}/);
        if (!match) {
            break;
        }
        const defaultValue = match[3];
        const value = additionalConfig[match[1] as keyof AdditionalConfig];
        if (value !== undefined) {
            // If the value is completely the pattern, return the value as is (could be non-string)
            if (`$\{${match[0]}}` === field) {
                return value;
            }
            // Else replace the pattern in the string
            field = field.replace(match[0], String(value));
        } else if (defaultValue !== undefined) {
            // If defaultValue is provided, use it
            if (match[0] === field) {
                if (defaultValue === 'true') {
                    return true;
                }
                if (defaultValue === 'false') {
                    return false;
                }
                if (!isNaN(Number(defaultValue))) {
                    return Number(defaultValue);
                }
                return defaultValue;
            }
            field = field.replace(match[0], defaultValue);
        } else {
            // If value is not found, replace with empty string
            field = field.replace(match[0], '');
        }
    } while (match);

    return field;
}

export function walkTheConfig(
    obj: any,
    instanceConfig: ioBroker.AdapterConfig,
    additionalConfig: AdditionalConfig,
): any {
    if (typeof obj === 'string') {
        return parseField(obj, instanceConfig, additionalConfig);
    }
    if (Array.isArray(obj)) {
        return obj.map(item => walkTheConfig(item, instanceConfig, additionalConfig));
    }
    if (obj !== null && typeof obj === 'object') {
        const result: any = {};
        for (const [key, value] of Object.entries(obj)) {
            result[key] = walkTheConfig(value, instanceConfig, additionalConfig);
        }
        return result;
    }
    return obj; // Return the value as is if it's not a string, array, or object
}
