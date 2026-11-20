# SACERDOS

An installable reader for the 23 Holy Thursday letters to priests and *Pastores Dabo Vobis* by Saint John Paul II.

Serve the app from `dist/` over HTTPS, or run `python3 -m http.server 8573 --directory dist` and visit http://localhost:8573. After the service worker caches the collection, indexed texts and search are available offline. Publisher links require an internet connection.

The original source catalog is preserved in `dist/sacerdos-source-catalog.json`. To refresh the text index, run `python3 scripts/import-editions.py` with internet access, curl, and Poppler’s `pdftotext` installed. Review import failures and spot-check the extracted passages. Change the cache version in `dist/sw.js` when updating cached content.

All 24 documents are available in English, Spanish, Italian, German, Dutch, Traditional Chinese, Simplified Chinese, Ukrainian, Russian, Arabic, French, and Polish. The index contains 118 publisher editions and 170 unofficial SACERDOS translations. Each generated translation carries a notice in its reading language and links to the source text.

To generate missing editions, run `python3 scripts/translate-editions.py` with Ollama and the `gemma4:26b` model running locally. The script resumes from checkpoints in `.translation-work/`. Once the batch completes, `python3 scripts/translate-editions.py --merge` checks passage structure and footnote numbering before adding the translations to the reading index. The reader labels every generated edition as an unofficial AI translation and links to its Italian source.
