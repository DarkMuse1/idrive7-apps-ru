'use strict';
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const C = require('./comfort-controller');
const bridge = require('./bridge');
const nativeTransport = require('./comfort-transport');
mgu.run({
    async start(ctx) {
        let latest = null, problem = '', working = false, mailbox = null, transport = null;
        // Initialization does not block RHMI startup and never writes lighting.
        if (ctx.signals.hasNative()) {
            const proxy = ctx.signals.proxy(C.IFACE, '1');
            proxy.catch(e => { problem = String(e.message || e); ctx.log.warn(problem); });
            transport = nativeTransport.create(proxy);
            mailbox = bridge.create(ctx.dataDir, transport);
        } else problem = 'Нет подключения к сервису автомобиля';
        ctx.loop('MAIN', 2, async () => {
            const t = ctx.theme(), cv = ctx.canvas(1600,520).clear(t.bg);
            cv.text('Подсветка салона', 45,100,38,t.text,{font:'bold'});
            cv.text('Проверка через MGU Tools на компьютере',45,145,24,t.dim);
            const state = latest && latest.state;
            cv.text(state ? 'Профиль: '+(state.profile === null ? 'нет данных' : state.profile) : 'Чтение состояния…',45,225,30,t.text);
            cv.text(state ? 'Подсветка: '+(state.enabled === null ? 'нет данных' : state.enabled ? 'включена' : 'выключена') : '',45,280,28,t.text);
            cv.text(state ? 'Уровень яркости HU: '+(state.brightnessOffset === null ? 'нет данных' : state.brightnessOffset) : '',45,335,28,t.text);
            cv.text(problem || (latest && latest.error) || 'Изменение выполняется только после подтверждения на компьютере.',45,400,23,t.dim);
            cv.text(latest && latest.write_blocked ? 'Результат прошлой записи не подтверждён. Повторная запись заблокирована.' : 'Журнал проверки сохраняется на компьютере.',45,450,22,t.dim);
            G.frame(cv,t,['Подсветка'],0,[{text:latest && latest.status==='ready'?'Сервис отвечает':'Нет данных'}]);
            await ctx.ui.image('MAIN_GFX',cv);
        });
        // Explicit timer also works while this app's screen is not selected.
        const timer = setInterval(() => {
            if (!mailbox || working) return;
            working = true;
            mailbox.tick().then(r => { if(r) latest = r; }, e => { problem=String(e.message||e);ctx.log.warn(problem); })
                .then(() => { working=false; });
        },1000);
        process.once('exit',()=>{ clearInterval(timer); if (transport) transport.close(); });
    },
});
