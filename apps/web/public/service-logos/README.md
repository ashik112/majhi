# Service logos

Brand marks from [Simple Icons 11.15.0](https://github.com/simple-icons/simple-icons/tree/11.15.0/icons), distributed under [CC0 1.0](https://github.com/simple-icons/simple-icons/blob/11.15.0/LICENSE.md). Shapes are unchanged; fills use the brands' colors. The SVG files are bundled locally so the connections page works offline and makes no requests to an icon CDN. Brand names and marks belong to their respective owners.

This folder is the one logo store for the whole app: the Connections page and the Map both read it. `apps/web/scripts/gen-logos.mjs` adds any brand the Map names from the pinned `simple-icons` package and derives `src/features/map/logos.generated.ts` from these files. Brands that later Simple Icons releases dropped (OpenAI, Twilio, Amazon S3) are kept from Simple Icons 11.15.0; Exa and Firecrawl come from [@lobehub/icons-static-svg 1.95.1](https://www.npmjs.com/package/@lobehub/icons-static-svg) (MIT).
