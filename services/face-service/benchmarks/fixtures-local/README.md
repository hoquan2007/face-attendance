# Benchmark Fixtures — Local Only

This directory is the **only** sanctioned location for real face images used
by `benchmark_engine.py` and `evaluate_pairs.py`.

Rules:

1. **Never commit face images.** The whole `fixtures-local/` tree (and any
   content placed inside it) is gitignored.
2. **Only use consented images.** Do not scrape the internet. Do not use
   celebrity photos. Only use images of people who have explicitly consented
   to the experiment, or synthetic / synthetic-looking test data.
3. Place files anywhere inside `fixtures-local/` — the benchmark scans
   recursively. Use the structure that best fits your experiment, e.g.:

   ```text
   fixtures-local/
   ├── single-face/        # one-face images (any name)
   ├── multi-face/         # 2+ face images
   └── pairs/              # for evaluate_pairs.py
       ├── manifest.csv    # path_a, path_b, label
       └── ...
   ```

4. If you delete an image, simply delete the file — no other bookkeeping.

The benchmark tools treat an empty `fixtures-local/` as "no fixtures
available" and exit gracefully rather than failing.
