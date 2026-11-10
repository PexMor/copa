// Entry of the <script>-tag bundle: registers <copa-share> and exposes `Copa.*`.
import { defineCopaShare } from './element';

defineCopaShare();

export * from './index';
