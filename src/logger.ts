import * as winston from 'winston'

const levels : winston.config.AbstractConfigSetLevels = {
    error: 0,
    warn: 1,
    info: 2,
    success: 3
};

const colors : winston.config.AbstractConfigSetColors = {
    "error": "red",
    "warn": "yellow",
    "info": "cyan",
    "verbose": "gray",
    "success": "green"
}

winston.addColors(colors);

const winstonFormat : winston.Logform.Format = winston.format.combine(
    winston.format(info => {
        info.level = info.level.toUpperCase()
        return info;
    })(),
    winston.format.label({
        label: '[LOGGER]'
    }),
    //winston.format.align(),
    winston.format.printf(
        (info) => `[${info.level}] ${info.message}`,
    )
);

interface CustomLevels extends winston.Logger {
    success: winston.LeveledLogMethod
}

const logger : CustomLevels = <CustomLevels>winston.createLogger({
    level: 'info',
    levels,
    format: winstonFormat,
    transports: [
        new winston.transports.Console({
            level: 'success',
            format: winston.format.combine(
                winston.format(info => {
                    info.level = info.level.toUpperCase()
                    return info;
                })(),
                winston.format.label({
                    label: '[LOGGER]'
                }),
                //winston.format.align(),
                winston.format.printf(
                    (info) => `[${info.level}] ${info.message}`,
                ),
                winston.format.colorize({
                    all: true
                })
            )
        }),
        new winston.transports.File({
            filename: 'logs/error.log',
            level: 'error',
        }),
        new winston.transports.File({
            filename: 'logs/all.log',
        }),
    ]
});

export default logger;