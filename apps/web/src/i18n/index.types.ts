// Compile-time guards: `next build` type-checks this file, so a regression in
// the key or parameter types fails the build. Nothing here runs.
import { interpolate, t } from './index';

t('home.title');
t('app.tagline');

// @ts-expect-error unknown key
t('x.missing');

// @ts-expect-error a key without placeholders takes no params
t('home.title', { name: 'x' });

interpolate('Hello, {name}!', { name: 'Ada' });
interpolate('No placeholders');

// @ts-expect-error a placeholder requires its param
interpolate('Hello, {name}!');

// @ts-expect-error the param must be named after the placeholder
interpolate('Hello, {name}!', { who: 'Ada' });
