# idrive7-apps-ru — русские приложения MGU для Магазина

Источник приложений для **MGU Store** (русская сборка:
[DarkMuse1/mgu-store-ru](https://github.com/DarkMuse1/mgu-store-ru)). Магазин
читает этот репозиторий как **дерево репозитория** по каналу **tags** и
собирает приложения прямо на головном устройстве BMW (iDrive 7, MGU) из
исходников — на русском языке.

Это русская редакция приложений
[cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps)
(MIT): те же приложения и инструментарий `kit/`, сборка с `--language ru`.

## Как это работает

- В `mgu-repo.json` шаблон `apps/*` собирает каждое приложение командой
  `python kit/tools/build.py <id> --language ru` (строки берутся из
  `kit/runtime/locales/ru.json`).
- Магазин ставит приложения вместе с их рендерером **idrive7-renderd 2.1.11**
  (`kit/renderd/prebuilt`, GPU-рендерер приложений, работает рядом с рендерером
  самого Магазина) и контроллерным шлюзом **mgu-inputgate 1.0.0** (вкладки,
  кнопки страниц, настройки, Doom).
- BMW oap-sdk в репозитории нет: Магазин генерирует его на автомобиле из
  приложения-донора перед сборкой (`"sdk": "oap-sdk"`).
- Только iDrive 7 (`"mguHmi": ["ID7"]`).

## Приложения

Отдельные приложения: M Vitals (`car_vitals`), Redline (`redline`),
Transmission Config (`zf8hp`), Drag Timer (`draggy`), eDrive (`edrive`),
Brake Test (`brake_test`), G-Force (`gforce`), Fault Scanner (`dtc_scanner`),
Virtual Dyno (`dyno`), Warm-Up (`warmup`), Live Data (`live_data`),
Engine Config (`live_adjustments`), Подсветка (`ambient_light`),
Service (`service`), Doom (`doom`), AA Cluster Companion
(`aa_cluster_companion`).

Единое приложение: **MGU Tools · всё в одном** (`mgu_unified`) — все модули под
одним значком, кроме отдельного экрана xDrive (отключение xDrive осталось в
Engine Config). На экране автомобиля пользователь ставит либо единое
приложение, либо отдельные.

## Версии и выпуск

В **v1.4.1** единое приложение **MGU Tools 0.1.8** переведено на такую же
выдачу кода по паролю, как «Подсветка». В открытом `apps/mgu_unified` находятся
только оболочка и бинарные ресурсы; рабочая реализация выдаётся сервером
`mgu.bmwexpertcode.com` после ввода пароля на ГУ. Нужен интернет на автомобиле.
ID `mgu_unified`, экраны, настройки и виджет сохранены. При фоновом запуске
виджет предлагает открыть приложение; экранная клавиатура появляется только
в открытом приложении. Пароль в пакете не хранится.

Код каждой защищённой версии хранится отдельно. При обновлении этого приложения
нельзя копировать необработанный `unified-mgu/build-input` поверх публичной
оболочки: используйте `unified-mgu/tools/publish_locked.py` из рабочего проекта
и публикуйте новую версию. Старые защищённые версии продолжают обращаться к
своим неизменяемым серверным наборам.

Последняя синхронизация — **v1.4.0**, upstream `180537a` от 07.11.2026:
eDrive **2.8.1** (экран аккумулятора 12 В и данные для HUD),
Redline **1.13.0** (экспериментальная проекция HUD через `cluster-render`),
Engine Config **0.8.1** (режимы заслонки и обновления xDrive).
Для новых экранов и настроек сохранена русская сборка и дополнен словарь.
Изменения runtime и наши приложения `ambient_light`, `mgu_unified`,
`aa_cluster_companion` сохранены; встроенные модули единого приложения
этой синхронизацией не заменяются.

- Версия каждого приложения — строго `x.y.z` (из его `app.json`). Пре-релизных
  суффиксов (например `-ru.1`) здесь нет: Магазин принимает только `x.y.z` и
  сравнивает версии по числам.
- Канал **tags**: Магазин читает приложения из коммита с наибольшим тегом
  `vX.Y.Z`. Новый выпуск — новый тег `vX.Y.Z` больше прежнего.
- Каждый выпуск: поднять `version` в `app.json` изменённых приложений,
  закоммитить, поставить тег `vX.Y.Z`.
- Doom при сборке скачивает данные игры (`network: ["doom"]`, Freedoom).
  У `mgu_unified` эти данные вложены в репозиторий (сборка офлайн).

## Проверка сборки на компьютере (офлайн, без BMW SDK)

```sh
python kit/tools/build.py car_vitals  --language ru --preview-only
python kit/tools/build.py mgu_unified --language ru --preview-only
```

`--preview-only` собирает без BMW oap-sdk (пакет помечается как не для
установки) — для проверки конвейера сборки. На автомобиле Магазин собирает с
настоящим SDK.

## Лицензии

- Приложения и `kit/` — MIT (`LICENSE`), по редакции idrive7-apps.
- Doom (`apps/doom`, модуль Doom в `mgu_unified`) — GPL-2.0: движок
  doomgeneric скомпилирован в `doom.wasm`; полный исходный код — в
  `third_party/doomgeneric`. Данные игры — Freedoom (BSD), см. `NOTICE`
  приложения.
- Рендерер `idrive7-renderd` (`kit/renderd`) — см. `kit/renderd/LICENSE` и
  `kit/renderd/LICENSE.mgu-renderd`.
