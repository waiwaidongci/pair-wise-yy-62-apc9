import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { MantineProvider, createTheme } from '@mantine/core';
import '@mantine/core/styles.css';
import { store } from './store';
import App from './App';
import './styles.css';

const theme = createTheme({
  primaryColor: 'teal',
  defaultRadius: 6,
  fontFamily: '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif',
  headings: { fontFamily: '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif' }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Provider store={store}>
      <MantineProvider theme={theme}><App /></MantineProvider>
    </Provider>
  </StrictMode>
);
