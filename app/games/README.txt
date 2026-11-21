The game that comes with the app: Pad_Test.sfc.

It was written for it, under the MIT licence. Its source is in games/ at the top of the repository;
"npm run build:games" (node games/build.js, with cc65) writes this file.

Every build packs this folder into the app, and the package the MGU Store installs has it too. So
nothing else belongs here: your own games go into app/roms/, which no published package includes.
